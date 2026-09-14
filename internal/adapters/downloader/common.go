// Package downloader tải video từ Douyin/TikTok/Facebook về đĩa, port lại phần THUẦN HTTP của
// tiktok-facebook-reuploader/lib/extractor.js (lib/videos.js). CHƯA port phần cần mở trình duyệt
// thật (Douyin ký a_bogus, TikTok trích rehydration data qua Puppeteer) — SnapTikTok engine đã là
// đường chính (thử trước tiên) cho cả TikTok lẫn Douyin ở bản gốc nên vẫn phủ phần lớn trường hợp
// thực tế; phần Puppeteer chỉ là dự phòng khi SnapTikTok/TikWM đều thất bại.
package downloader

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	userAgent       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	mobileUserAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1"
)

// Extracted là kết quả bóc tách 1 link nguồn — đủ thông tin để tải file thật về.
type Extracted struct {
	Platform string // "tiktok" | "douyin" | "facebook" | "direct"
	ID       string
	Title    string
	VideoURL string
	Referer  string
}

// noRedirectClient dùng cho resolveShortURL — cần đọc header Location thủ công thay vì để Go tự
// đi theo redirect, giống `redirect: 'manual'` bên fetch() của Node.
var noRedirectClient = &http.Client{
	Timeout: 15 * time.Second,
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

var httpClient = &http.Client{Timeout: 30 * time.Second}

// resolveShortURL đi theo tối đa 5 lượt chuyển hướng cho các link rút gọn (v.douyin.com,
// vt.tiktok.com, fb.watch, facebook.com/share, t.co, bit.ly...) để ra URL đầy đủ cuối cùng.
func resolveShortURL(rawURL string) string {
	current := rawURL
	shortHosts := []string{"v.douyin.com", "vt.tiktok.com", "fb.watch", "fb.gg", "fb.me", "facebook.com/share", "t.co", "bit.ly"}

	for i := 0; i < 5; i++ {
		isShort := false
		for _, h := range shortHosts {
			if strings.Contains(current, h) {
				isShort = true
				break
			}
		}
		if !isShort {
			break
		}

		req, err := http.NewRequest(http.MethodGet, current, nil)
		if err != nil {
			break
		}
		req.Header.Set("User-Agent", userAgent)

		resp, err := noRedirectClient.Do(req)
		if err != nil {
			break
		}
		location := resp.Header.Get("Location")
		resp.Body.Close()
		if location == "" {
			break
		}
		if strings.HasPrefix(location, "/") {
			if u, err := url.Parse(current); err == nil {
				current = fmt.Sprintf("%s://%s%s", u.Scheme, u.Host, location)
				continue
			}
			break
		}
		current = location
	}
	return current
}

// cleanURL bỏ escape "\/" hay gặp trong JSON nhúng sẵn trong HTML (giống cleanUrl bên Node).
func cleanURL(escaped string) string {
	if escaped == "" {
		return ""
	}
	r := strings.NewReplacer(`\/`, "/", `\`, "")
	return r.Replace(escaped)
}

// stableHashID tạo id ổn định từ URL (bỏ query string) — dùng cho link CDN dán trực tiếp không
// thuộc nền tảng nào, giống extractDirectMedia bên Node.
func stableHashID(rawURL string) string {
	key := rawURL
	if u, err := url.Parse(rawURL); err == nil {
		key = u.Hostname() + u.Path
	}
	sum := sha1.Sum([]byte(key))
	return hex.EncodeToString(sum[:])[:16]
}

// ExtractDirectMedia coi 1 URL bất kỳ (không thuộc TikTok/Douyin/Facebook) là link CDN gốc dán
// trực tiếp — không nhận diện được platform, id sinh từ hash URL.
func ExtractDirectMedia(rawURL string) *Extracted {
	return &Extracted{
		Platform: "direct",
		ID:       stableHashID(rawURL),
		Title:    "Video tải trực tiếp",
		VideoURL: rawURL,
	}
}

// Extract nhận diện nền tảng qua URL rồi bóc tách — KHÔNG tải file, chỉ lấy link + tiêu đề.
func Extract(rawURL string) (*Extracted, error) {
	target := resolveShortURL(strings.TrimSpace(rawURL))

	switch {
	case strings.Contains(target, "facebook.com") || strings.Contains(target, "fb.watch"):
		return extractFacebook(target)
	case strings.Contains(target, "tiktok.com"):
		return extractTikTok(target)
	case strings.Contains(target, "douyin.com") || strings.Contains(target, "iesdouyin.com"):
		return extractDouyin(target)
	default:
		return ExtractDirectMedia(target), nil
	}
}

// DownloadResult trả về sau khi tải xong file thật xuống đĩa.
type DownloadResult struct {
	ID       string
	Title    string
	FilePath string
	Reused   bool // file đã có sẵn trên đĩa từ lần tải trước, không tải lại
}

// Download bóc tách rawURL rồi tải file video thật về destDir, đặt tên theo
// "<platform>-<id>.mp4" — trùng tên (đã tải trước đó) thì dùng lại luôn, không tải lại.
func Download(destDir, rawURL string) (*DownloadResult, error) {
	ext, err := Extract(rawURL)
	if err != nil {
		return nil, err
	}
	if ext.VideoURL == "" {
		return nil, fmt.Errorf("không lấy được link tải video từ nguồn này")
	}

	if err := os.MkdirAll(destDir, 0755); err != nil {
		return nil, fmt.Errorf("không tạo được thư mục tải về: %w", err)
	}

	filename := fmt.Sprintf("%s-%s.mp4", ext.Platform, ext.ID)
	filePath := filepath.Join(destDir, filename)

	if info, err := os.Stat(filePath); err == nil && !info.IsDir() && info.Size() > 0 {
		return &DownloadResult{ID: ext.ID, Title: ext.Title, FilePath: filePath, Reused: true}, nil
	}

	req, err := http.NewRequest(http.MethodGet, ext.VideoURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	if ext.Referer != "" {
		req.Header.Set("Referer", ext.Referer)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("lỗi tải video: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("lỗi tải video: HTTP %d", resp.StatusCode)
	}

	tmpPath := filePath + ".part"
	f, err := os.Create(tmpPath)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return nil, fmt.Errorf("lỗi ghi file video: %w", err)
	}
	f.Close()

	if err := os.Rename(tmpPath, filePath); err != nil {
		return nil, err
	}

	return &DownloadResult{ID: ext.ID, Title: ext.Title, FilePath: filePath}, nil
}
