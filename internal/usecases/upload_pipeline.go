package usecases

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"uptik/internal/adapters/browser"
	"uptik/internal/domain"
	"uptik/internal/ports"

	"github.com/go-rod/rod"
)

type UploadPipelineUseCase struct {
	registry    ports.PlatformRegistry
	historyRepo ports.HistoryRepository
	jobQueue    ports.JobQueue
	profileRepo ports.ProfileRepository
	logFn       func(level, msg string)
}

func NewUploadPipelineUseCase(
	registry ports.PlatformRegistry,
	historyRepo ports.HistoryRepository,
	jobQueue ports.JobQueue,
	profileRepo ports.ProfileRepository,
	logFn func(level, msg string),
) *UploadPipelineUseCase {
	return &UploadPipelineUseCase{
		registry:    registry,
		historyRepo: historyRepo,
		jobQueue:    jobQueue,
		profileRepo: profileRepo,
		logFn:       logFn,
	}
}

func (uc *UploadPipelineUseCase) Log(level, msg string) {
	if uc.logFn != nil {
		uc.logFn(level, msg)
	}
}

// ProcessJob uploads a single job across all its target profiles (hồ sơ) sequentially. Mỗi hồ sơ
// đăng qua 1 ngữ cảnh trình duyệt CÔ LẬP riêng (browser.NewProfileContext), tiêm đúng cookie của
// hồ sơ đó trước khi mở trang — không dùng chung 1 browser/session cho mọi hồ sơ như uptik gốc, vì
// ở đây 1 nền tảng có thể có nhiều hồ sơ/tài khoản khác nhau cùng lúc.
func (uc *UploadPipelineUseCase) ProcessJob(ctx context.Context, b *rod.Browser, job *ports.JobItem) error {
	item := &job.Video
	targetProfileIDs := job.TargetChannels
	if item.Channels == nil {
		item.Channels = make(map[string]domain.ChannelStatus)
	}

	uc.Log("info", fmt.Sprintf("🚀 [PIPELINE] Starting upload job: %s (%d hồ sơ: %s)", item.CustomTitle, len(targetProfileIDs), strings.Join(targetProfileIDs, ", ")))

	// Mark state to uploading in queue
	_ = uc.jobQueue.MarkState(ctx, job.ID, ports.JobStateUploading, "")

	var successfulChannels []string
	var failedChannels []string

	for idx, profileID := range targetProfileIDs {
		select {
		case <-ctx.Done():
			_ = uc.jobQueue.MarkState(ctx, job.ID, ports.JobStateCancelled, "User cancelled upload operation")
			return ctx.Err()
		default:
		}

		profile, err := uc.profileRepo.GetProfile(profileID)
		if err != nil {
			uc.Log("error", fmt.Sprintf("Bỏ qua hồ sơ không tồn tại %s: %v", profileID, err))
			item.Channels[profileID] = domain.ChannelStatus{Status: "error", ErrorMsg: "Hồ sơ đã bị xoá."}
			failedChannels = append(failedChannels, profileID)
			continue
		}

		platform, err := uc.registry.Get(profile.Platform)
		if err != nil {
			uc.Log("error", fmt.Sprintf("Bỏ qua hồ sơ %s: nền tảng %s không hỗ trợ: %v", profile.Label, profile.Platform, err))
			item.Channels[profileID] = domain.ChannelStatus{Status: "error", ErrorMsg: err.Error()}
			failedChannels = append(failedChannels, profileID)
			continue
		}

		uc.Log("info", fmt.Sprintf("▶️ [%d/%d] Đăng lên %s (hồ sơ: %s)...", idx+1, len(targetProfileIDs), platform.DisplayName(), profile.Label))
		item.Channels[profileID] = domain.ChannelStatus{Status: "uploading"}

		// Hồ sơ không có cookie (CookiesJSON rỗng) = dùng thẳng browser hiện có, coi như đã đăng
		// nhập thủ công sẵn (giống cách uptik gốc hoạt động) — chỉ tạo ngữ cảnh cô lập + tiêm
		// cookie khi hồ sơ THỰC SỰ có cookie riêng, để hỗ trợ nhiều tài khoản cùng nền tảng.
		profileBrowser := b
		if profile.CookiesJSON != "" {
			ctxBrowser, ctxErr := browser.NewProfileContext(b, profile.CookiesJSON)
			if ctxErr != nil {
				uc.Log("error", fmt.Sprintf("❌ Không tạo được phiên trình duyệt cho hồ sơ %s: %v", profile.Label, ctxErr))
				item.Channels[profileID] = domain.ChannelStatus{Status: "error", ErrorMsg: ctxErr.Error()}
				failedChannels = append(failedChannels, profileID)
				continue
			}
			profileBrowser = ctxBrowser
		}

		uploadErr := platform.UploadVideo(ctx, profileBrowser, item, uc.logFn)
		if profileBrowser != b {
			_ = profileBrowser.Close()
		}

		if uploadErr != nil {
			uc.Log("error", fmt.Sprintf("❌ Upload failed on %s (%s): %v", platform.DisplayName(), profile.Label, uploadErr))
			chStatus := "error"
			if errors.Is(uploadErr, domain.ErrContentRestricted) {
				chStatus = "restricted"
			}
			item.Channels[profileID] = domain.ChannelStatus{
				Status:   chStatus,
				ErrorMsg: uploadErr.Error(),
			}
			failedChannels = append(failedChannels, profileID)
		} else {
			uc.Log("success", fmt.Sprintf("✅ Upload succeeded on %s (%s)!", platform.DisplayName(), profile.Label))
			item.Channels[profileID] = domain.ChannelStatus{
				Status:     "scheduled",
				UploadedAt: time.Now().Format("15:04:05"),
			}
			successfulChannels = append(successfulChannels, profileID)
		}

		// Courtesy delay between profiles to free resources & prevent spam detection
		if idx < len(targetProfileIDs)-1 {
			uc.Log("info", "⏳ Pausing 5s before next profile to release resources...")
			time.Sleep(5 * time.Second)
		}
	}

	// Record to history if at least one succeeded
	if len(successfulChannels) > 0 && uc.historyRepo != nil {
		_ = uc.historyRepo.Append(domain.HistoryRecord{
			Filename:      item.Filename,
			Title:         item.CustomTitle,
			ScheduledDate: item.ScheduledDate,
			ScheduledTime: item.ScheduledTime,
			Channels:      successfulChannels,
			Timestamp:     time.Now().UTC().Format(time.RFC3339),
		})
	}

	// If all channels succeeded: safe move to uploaded/ and mark completed
	if len(failedChannels) == 0 && len(successfulChannels) > 0 {
		item.Status = "scheduled"
		item.UploadedAt = time.Now().Format("15:04:05")

		_ = uc.SafeArchive(*item)
		_ = uc.jobQueue.MarkState(ctx, job.ID, ports.JobStateCompleted, "")
		return nil
	}

	// Partial success
	if len(successfulChannels) > 0 && len(failedChannels) > 0 {
		item.Status = "partial"
		item.UploadedAt = time.Now().Format("15:04:05")
		errMsg := fmt.Sprintf("Succeeded on %s, failed on: %s", strings.Join(successfulChannels, ", "), strings.Join(failedChannels, ", "))
		for _, st := range item.Channels {
			if st.Status == "restricted" {
				if qErr := uc.SafeQuarantine(*item); qErr != nil {
					item.Status = "error"
					errMsg = fmt.Sprintf("Succeeded on %s, but quarantine failed for restricted video: %v", strings.Join(successfulChannels, ", "), qErr)
					_ = uc.jobQueue.MarkState(ctx, job.ID, ports.JobStateFailed, errMsg)
					return fmt.Errorf("%s", errMsg)
				}
				break
			}
		}
		_ = uc.jobQueue.MarkState(ctx, job.ID, ports.JobStatePartial, errMsg)
		return fmt.Errorf("%s", errMsg)
	}

	// Check if video was restricted on channels without success -> quarantine to prevent repeated pickup
	isRestricted := false
	for _, st := range item.Channels {
		if st.Status == "restricted" {
			isRestricted = true
			break
		}
	}

	if isRestricted && len(successfulChannels) == 0 {
		if err := uc.SafeQuarantine(*item); err != nil {
			item.Status = "error"
			errMsg := fmt.Sprintf("Content restricted on %s, but quarantine failed: %v", strings.Join(failedChannels, ", "), err)
			_ = uc.jobQueue.MarkState(ctx, job.ID, ports.JobStateFailed, errMsg)
			return fmt.Errorf("%s", errMsg)
		}
		item.Status = "restricted"
		errMsg := fmt.Sprintf("Quarantined: content restricted on %s", strings.Join(failedChannels, ", "))
		_ = uc.jobQueue.MarkState(ctx, job.ID, ports.JobStateFailed, errMsg)
		return fmt.Errorf("%s", errMsg)
	}

	// Total failure
	item.Status = "error"
	errMsg := fmt.Sprintf("Failed on all channels: %s", strings.Join(failedChannels, ", "))
	_ = uc.jobQueue.MarkState(ctx, job.ID, ports.JobStateFailed, errMsg)
	return fmt.Errorf("%s", errMsg)
}

// SafeArchive moves an uploaded video to uploaded/ subfolder atomically
func (uc *UploadPipelineUseCase) SafeArchive(video domain.VideoItem) error {
	folder := filepath.Dir(video.FullPath)
	uploadedDir := filepath.Join(folder, "uploaded")
	_ = os.MkdirAll(uploadedDir, 0755)

	destPath := filepath.Join(uploadedDir, video.Filename)
	err := os.Rename(video.FullPath, destPath)
	if err != nil {
		uc.Log("warn", fmt.Sprintf("Warning: could not move uploaded file: %v", err))
		return err
	}
	uc.Log("success", fmt.Sprintf("📁 Video safely archived to: uploaded/%s", video.Filename))
	return nil
}

// SafeQuarantine moves a restricted video to restricted/ subfolder atomically to prevent repeated failures
func (uc *UploadPipelineUseCase) SafeQuarantine(video domain.VideoItem) error {
	folder := filepath.Dir(video.FullPath)
	restrictedDir := filepath.Join(folder, "restricted")
	if err := os.MkdirAll(restrictedDir, 0755); err != nil {
		uc.Log("warn", fmt.Sprintf("Warning: could not create restricted directory: %v", err))
		return err
	}

	ext := filepath.Ext(video.Filename)
	base := strings.TrimSuffix(video.Filename, ext)

	// Atomic exclusive destination reservation to eliminate TOCTOU race
	var destFilename string
	var destPath string
	for attempt := 0; attempt < 100; attempt++ {
		if attempt == 0 {
			destFilename = video.Filename
		} else {
			destFilename = fmt.Sprintf("%s_%d_%d%s", base, time.Now().UnixNano(), attempt, ext)
		}
		candidate := filepath.Join(restrictedDir, destFilename)

		// Attempt atomic creation with O_CREATE|os.O_EXCL
		f, err := os.OpenFile(candidate, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
		if err != nil {
			if os.IsExist(err) {
				continue
			}
			uc.Log("warn", fmt.Sprintf("Warning: failed to reserve destination file %s: %v", candidate, err))
			return err
		}
		_ = f.Close()
		destPath = candidate
		break
	}

	if destPath == "" {
		return fmt.Errorf("failed to find an available unique destination in %s after 100 attempts", restrictedDir)
	}

	err := os.Rename(video.FullPath, destPath)
	if err != nil {
		_ = os.Remove(destPath) // clean up reserved placeholder on failure
		uc.Log("warn", fmt.Sprintf("Warning: could not move restricted file: %v", err))
		return err
	}
	uc.Log("warn", fmt.Sprintf("📁 Video quarantined to: restricted/%s (Ineligible for recommendation)", destFilename))
	return nil
}
