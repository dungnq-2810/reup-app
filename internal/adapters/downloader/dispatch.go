package downloader

import "fmt"

// extractTikTok: ưu tiên SnapTikTok (bản gốc master không nén), dự phòng TikWM.
// CHƯA port nhánh Puppeteer trực tiếp (extractTikTokDirect bên bản Node) — xem ghi chú ở common.go.
func extractTikTok(targetURL string) (*Extracted, error) {
	if snap, err := extractViaSnapTikTok(targetURL); err == nil && snap != nil {
		return snap, nil
	}

	tikwm, err := extractTikTokViaTikwm(targetURL)
	if err != nil {
		return nil, err
	}
	if tikwm == nil {
		return nil, fmt.Errorf("không lấy được video TikTok từ nguồn này")
	}
	return tikwm, nil
}

// extractDouyin: ưu tiên SnapTikTok. CHƯA port nhánh HTTP API ký a_bogus và nhánh Puppeteer dự
// phòng bên bản Node — video Douyin cần đăng nhập/bị chặn tạm sẽ báo lỗi rõ ràng để người dùng
// biết mà thử lại thay vì mở trình duyệt thật.
func extractDouyin(targetURL string) (*Extracted, error) {
	if snap, err := extractViaSnapTikTok(targetURL); err == nil && snap != nil {
		return snap, nil
	}
	return nil, fmt.Errorf("không lấy được video Douyin từ nguồn này (có thể cần đăng nhập hoặc bị chặn tạm thời) — thử lại sau")
}
