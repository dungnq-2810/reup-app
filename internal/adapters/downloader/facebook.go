package downloader

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

var (
	fbVParam        = regexp.MustCompile(`^\d+$`)
	fbNumericInPath = regexp.MustCompile(`/(\d{10,25})`)
	fbHDMatch       = regexp.MustCompile(`browser_native_hd_url["']:\s*["'](https?:.*?)(["'])`)
	fbSDMatch       = regexp.MustCompile(`browser_native_sd_url["']:\s*["'](https?:.*?)(["'])`)
	fbPlayableHD    = regexp.MustCompile(`"playable_url_quality_hd"["']:\s*["'](https?:.*?)(["'])`)
	fbPlayableSD    = regexp.MustCompile(`"playable_url"["']:\s*["'](https?:.*?)(["'])`)
	fbOgTitle       = regexp.MustCompile(`(?i)<meta\s+property=["']og:title["']\s+content=["'](.*?)["']`)
	fbOgURL         = regexp.MustCompile(`(?i)<meta\s+property=["']og:url["']\s+content=["'](https?:.*?)["']`)
)

func extractFacebookVideoID(rawURL string) string {
	if u, err := url.Parse(rawURL); err == nil {
		if v := u.Query().Get("v"); v != "" && fbVParam.MatchString(v) {
			return v
		}
		parts := strings.Split(u.Path, "/")
		for i, p := range parts {
			if (p == "videos" || p == "reel" || p == "watch" || p == "show") && i+1 < len(parts) {
				digits := regexp.MustCompile(`[^0-9]`).ReplaceAllString(parts[i+1], "")
				if digits != "" {
					return digits
				}
			}
		}
	}
	if m := fbNumericInPath.FindStringSubmatch(rawURL); m != nil {
		return m[1]
	}
	return ""
}

func htmlUnescapeFacebookTitle(raw string) string {
	r := strings.NewReplacer(
		"&#xb7;", "·", "&#064;", "@", "&#039;", "'", "&quot;", `"`,
		"&amp;", "&", "&lt;", "<", "&gt;", ">",
	)
	return r.Replace(raw)
}

func extractFacebook(targetURL string) (*Extracted, error) {
	videoID := extractFacebookVideoID(targetURL)
	fbTargetURL := targetURL

	if videoID == "" || strings.Contains(targetURL, "/share/") {
		req, _ := http.NewRequest(http.MethodGet, targetURL, nil)
		req.Header.Set("User-Agent", mobileUserAgent)
		req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
		req.Header.Set("Accept-Language", "en-US,en;q=0.9")
		if resp, err := httpClient.Do(req); err == nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if m := fbOgURL.FindSubmatch(body); m != nil {
				fbTargetURL = string(m[1])
				videoID = extractFacebookVideoID(fbTargetURL)
			}
		}
	}

	if videoID == "" {
		return nil, fmt.Errorf("không thể tìm thấy ID video từ đường dẫn Facebook này")
	}

	watchURL := fmt.Sprintf("https://www.facebook.com/watch/?v=%s", videoID)
	req, _ := http.NewRequest(http.MethodGet, watchURL, nil)
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("lỗi kết nối Facebook: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("lỗi kết nối Facebook: status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	html := string(body)

	pick := func(re *regexp.Regexp) string {
		if m := re.FindStringSubmatch(html); m != nil {
			return cleanURL(m[1])
		}
		return ""
	}

	videoURL := pick(fbHDMatch)
	if videoURL == "" {
		videoURL = pick(fbPlayableHD)
	}
	if videoURL == "" {
		videoURL = pick(fbSDMatch)
	}
	if videoURL == "" {
		videoURL = pick(fbPlayableSD)
	}
	if videoURL == "" {
		return nil, fmt.Errorf("không thể tìm thấy liên kết tải video Facebook — hãy chắc chắn đó là video công khai")
	}

	title := "Facebook Video"
	if m := fbOgTitle.FindStringSubmatch(html); m != nil {
		title = htmlUnescapeFacebookTitle(m[1])
	}

	return &Extracted{
		Platform: "facebook",
		ID:       videoID,
		Title:    title,
		VideoURL: videoURL,
		Referer:  "https://www.facebook.com/",
	}, nil
}
