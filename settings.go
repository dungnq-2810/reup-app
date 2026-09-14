package main

import (
	"os"
	"path/filepath"

	"uptik/internal/domain"
)

// AppVersion is the current version of this desktop app.
const AppVersion = "0.1.0"

// GetDefaultSettings returns sensible first-run defaults for Windows.
// Cấu hình mặc định khi chưa có settings nào lưu trong SQLite.
func GetDefaultSettings() domain.Settings {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		homeDir = "."
	}

	return domain.Settings{
		VideoFolder:            filepath.Join(homeDir, "reup-desktop", "downloads"),
		ChromePath:             "",
		DefaultTag:             "",
		GoldenHours:            []string{"11:30", "18:30", "21:30"},
		ScheduleGoldenHours:    []string{"11:30", "18:30", "21:30"},
		PublishNowGoldenHours:  []string{"07:30", "11:30", "14:30", "18:30", "21:30"},
		MaxDays:                30,
		Headless:               false,
		CdpPort:                9222,
		EnabledChannels:        []string{"tiktok", "facebook"},
		PublishMode:            domain.PublishModeSchedule,
		AutoUploadEnabled:      false,
		MissedSlotPolicy:       "skip",
		TikTokRestrictedPolicy: domain.TikTokRestrictedPolicySkip,
		Locale:                 "vi",
	}
}
