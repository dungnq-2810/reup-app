// Package browser cung cấp tiện ích tiêm cookie của 1 Hồ sơ (tài khoản) cụ thể vào 1 ngữ cảnh
// trình duyệt cô lập, thay cho việc dùng chung 1 Chrome profile đã đăng nhập thật như uptik gốc.
package browser

import (
	"encoding/json"
	"fmt"

	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/proto"
)

// rawCookie ánh xạ định dạng cookie JSON xuất ra từ trình duyệt/extension phổ biến (Puppeteer,
// EditThisCookie, Cookie-Editor...) — tương thích với cookie đang dùng ở bản Node.js hiện tại
// (lib/browserHandler.js: sanitizeCookiesForPuppeteer).
type rawCookie struct {
	Name           string      `json:"name"`
	Value          string      `json:"value"`
	Domain         string      `json:"domain"`
	Path           string      `json:"path"`
	Expires        json.Number `json:"expires"`
	ExpirationDate json.Number `json:"expirationDate"`
	HTTPOnly       bool        `json:"httpOnly"`
	Secure         bool        `json:"secure"`
	SameSite       string      `json:"sameSite"`
}

var validSameSite = map[string]proto.NetworkCookieSameSite{
	"Strict": proto.NetworkCookieSameSiteStrict,
	"Lax":    proto.NetworkCookieSameSiteLax,
	"None":   proto.NetworkCookieSameSiteNone,
}

// ParseCookiesJSON chuẩn hoá cookie JSON tự do (có thể lẫn field lạ, khác tên field giữa các nguồn
// export) về đúng dạng CDP chấp nhận — lọc bỏ từng cookie thiếu name/value/domain thay vì để cả
// mảng bị từ chối chỉ vì 1 cookie sai định dạng.
func ParseCookiesJSON(raw string) ([]*proto.NetworkCookieParam, error) {
	var list []rawCookie
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, fmt.Errorf("cookie JSON không hợp lệ: %w", err)
	}

	var out []*proto.NetworkCookieParam
	for _, c := range list {
		if c.Name == "" || c.Value == "" || c.Domain == "" {
			continue
		}
		path := c.Path
		if path == "" {
			path = "/"
		}
		param := &proto.NetworkCookieParam{
			Name:     c.Name,
			Value:    c.Value,
			Domain:   c.Domain,
			Path:     path,
			HTTPOnly: c.HTTPOnly,
			Secure:   c.Secure,
		}
		if ss, ok := validSameSite[c.SameSite]; ok {
			param.SameSite = ss
		}
		expires := c.Expires
		if expires == "" {
			expires = c.ExpirationDate
		}
		if f, err := expires.Float64(); err == nil && f > 0 {
			param.Expires = proto.TimeSinceEpoch(f)
		}
		out = append(out, param)
	}
	return out, nil
}

// NewProfileContext tạo 1 ngữ cảnh trình duyệt CÔ LẬP (incognito) và tiêm cookie của đúng hồ sơ vào
// — mỗi hồ sơ (tài khoản) dùng 1 ngữ cảnh riêng, không lẫn cookie/session giữa các hồ sơ cùng nền
// tảng dù chạy chung 1 tiến trình Chrome. Gọi Close() trên browser trả về sau khi dùng xong job.
func NewProfileContext(root *rod.Browser, cookiesJSON string) (*rod.Browser, error) {
	if root == nil {
		return nil, fmt.Errorf("chưa kết nối được trình duyệt")
	}
	cookies, err := ParseCookiesJSON(cookiesJSON)
	if err != nil {
		return nil, err
	}
	if len(cookies) == 0 {
		return nil, fmt.Errorf("hồ sơ không có cookie hợp lệ")
	}

	ctx, err := root.Incognito()
	if err != nil {
		return nil, fmt.Errorf("không tạo được ngữ cảnh trình duyệt cô lập: %w", err)
	}
	if err := ctx.SetCookies(cookies); err != nil {
		return nil, fmt.Errorf("không tiêm được cookie: %w", err)
	}
	return ctx, nil
}
