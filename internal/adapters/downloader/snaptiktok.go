package downloader

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var (
	snapTitleRe = regexp.MustCompile(`(?s)<h3>(.*?)</h3>`)
	snapTagRe   = regexp.MustCompile(`<[^>]+>`)
	snapIDRe    = regexp.MustCompile(`id="TikTokId"\s+value="([^"]+)"`)
	snapDigitsRe = regexp.MustCompile(`\d{15,22}`)
	snapLinkRe  = regexp.MustCompile(`(?s)<a[^>]*class="[^"]*button[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)</a>`)
	snapTokenRe = regexp.MustCompile(`token=([^&"']+)`)
)

type snapTokenPayload struct {
	URL      string `json:"url"`
	Filename string `json:"filename"`
}

func decodeSnapToken(token string) (string, bool) {
	// Token dạng JWT-ish "header.payload.sig" — payload là base64(url-safe hoặc chuẩn, có/không
	// padding) chứa JSON {url, filename}. Thử lần lượt các biến thể giống độ khoan dung của
	// Buffer.from(str, 'base64') bên Node.
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return "", false
	}
	payload := parts[1]

	decoders := []func(string) ([]byte, error){
		base64.RawURLEncoding.DecodeString,
		base64.URLEncoding.DecodeString,
		base64.RawStdEncoding.DecodeString,
		base64.StdEncoding.DecodeString,
	}
	for _, dec := range decoders {
		if data, err := dec(payload); err == nil {
			var p snapTokenPayload
			if json.Unmarshal(data, &p) == nil && p.URL != "" {
				return p.URL, true
			}
		}
	}
	return "", false
}

// extractViaSnapTikTok bóc tách bản gốc master (_original.mp4, có thể 200MB+ Full HD) không có
// watermark cho cả TikTok lẫn Douyin qua dịch vụ SnapTikTok — đường CHÍNH, thử trước tiên.
func extractViaSnapTikTok(targetURL string) (*Extracted, error) {
	form := url.Values{"q": {targetURL}, "lang": {"vi"}}
	req, err := http.NewRequest(http.MethodPost, "https://snaptiktok.to/api/ajaxSearch", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Referer", "https://snaptiktok.to/vi/douyin-downloader")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, nil
	}

	var result struct {
		Status string `json:"status"`
		Data   string `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if result.Status != "ok" || result.Data == "" {
		return nil, nil
	}
	html := result.Data

	title := ""
	if m := snapTitleRe.FindStringSubmatch(html); m != nil {
		title = strings.TrimSpace(snapTagRe.ReplaceAllString(m[1], ""))
	}

	id := ""
	if m := snapIDRe.FindStringSubmatch(html); m != nil {
		id = m[1]
	} else if m := snapDigitsRe.FindString(targetURL); m != "" {
		id = m
	} else {
		id = "video"
	}

	var bestVideoURL string
	var firstQualityURL string
	for _, m := range snapLinkRe.FindAllStringSubmatch(html, -1) {
		rawHref := m[1]
		labelText := strings.TrimSpace(snapTagRe.ReplaceAllString(m[2], ""))
		if rawHref == "" || rawHref == "/" || strings.HasPrefix(rawHref, "#") {
			continue
		}

		directURL := rawHref
		if tm := snapTokenRe.FindStringSubmatch(rawHref); tm != nil {
			if decodedURL, decodedOK := decodeSnapToken(tm[1]); decodedOK {
				directURL = decodedURL
			}
		}

		lower := strings.ToLower(labelText)
		if strings.Contains(lower, "mp3") {
			continue // nhạc nền — bỏ qua, chỉ quan tâm video
		}

		isHD := strings.Contains(lower, "hd") || strings.Contains(directURL, "_original.mp4")
		if firstQualityURL == "" {
			firstQualityURL = directURL
		}
		if isHD {
			bestVideoURL = directURL
			break
		}
	}
	if bestVideoURL == "" {
		bestVideoURL = firstQualityURL
	}
	if bestVideoURL == "" {
		return nil, nil
	}

	platform := "tiktok"
	if strings.Contains(targetURL, "douyin") {
		platform = "douyin"
	}

	if title == "" {
		title = "Video tải về"
	}
	return &Extracted{Platform: platform, ID: id, Title: title, VideoURL: bestVideoURL}, nil
}

// extractTikTokViaTikwm là dự phòng cuối cùng cho TikTok khi SnapTikTok thất bại — tikwm re-encode
// lại video qua server của họ nên luôn nén hơn bản gốc, nhưng vẫn không watermark và đủ dùng.
func extractTikTokViaTikwm(targetURL string) (*Extracted, error) {
	apiURL := "https://www.tikwm.com/api/?url=" + url.QueryEscape(targetURL) + "&hd=1"
	req, _ := http.NewRequest(http.MethodGet, apiURL, nil)
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("lỗi kết nối API TikTok: status %d", resp.StatusCode)
	}

	var result struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			ID       interface{} `json:"id"`
			Title    string      `json:"title"`
			Play     string      `json:"play"`
			HDPlay   string      `json:"hdplay"`
			Size     int64       `json:"size"`
			HDSize   int64       `json:"hd_size"`
			Cover    string      `json:"cover"`
			Duration int         `json:"duration"`
		} `json:"data"`
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, err
	}
	if result.Code != 0 {
		msg := result.Msg
		if msg == "" {
			msg = "Không thể tải thông tin video TikTok này."
		}
		return nil, fmt.Errorf("%s", msg)
	}

	bestURL := result.Data.Play
	if result.Data.HDPlay != "" && result.Data.HDSize >= result.Data.Size {
		bestURL = result.Data.HDPlay
	}
	if bestURL == "" {
		bestURL = result.Data.HDPlay
	}
	if bestURL == "" {
		return nil, nil
	}

	id := fmt.Sprintf("%v", result.Data.ID)
	title := result.Data.Title
	if title == "" {
		title = "Untitled TikTok Video"
	}

	return &Extracted{Platform: "tiktok", ID: id, Title: title, VideoURL: bestURL}, nil
}
