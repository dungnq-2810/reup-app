# ⚠️ Đây là bản SAO CHÉP tham khảo — KHÔNG phải code của app này, KHÔNG build/chạy được

Toàn bộ thư mục này (`docs/reference-node-app/`) chỉ để ĐỌC THAM KHẢO. Không sửa file `.js` ở đây
để "sửa app" — sửa không có tác dụng gì, không ai import/build các file này cả. Muốn sửa app Go
thật thì sửa trong `internal/`/`frontend/` ở gốc repo.

Các file `.js` trong `lib/` ở đây được copy nguyên văn từ project **`tiktok-facebook-reuploader`**
— repo GitHub RIÊNG, KHÔNG nằm trong repo `reup-app` này:
**https://github.com/dungnq-2810/tiktok-facebook-reuploader**
(app web Node.js đang chạy song song, quản lý nhiều user/nhiều hồ sơ, có Telegram bot — muốn xem
bản mới nhất/đối chiếu kỹ hơn thì clone thẳng repo đó về, đừng chỉ dựa vào bản copy tĩnh ở đây).

Copy vào đây vì: `reup-desktop` (app Go này) port lại 1 phần logic từ chính các file này (xem bảng
bên dưới), và khi đẩy `reup-desktop` lên repo Git riêng, session Claude Code khác máy sẽ **không
còn nhìn thấy** project Node.js gốc nữa — nếu cần đối chiếu/port thêm gì thì nguồn thật vẫn nằm ở
những file này, chép sẵn vào đây cho khỏi mất.

**Lưu ý**: đây là bản chụp tại thời điểm 2026-09-14 — nếu sau này project Node.js gốc sửa tiếp
(vẫn đang là app chính chạy production), file ở đây sẽ CŨ dần, không tự đồng bộ.

## Đã port sang Go (file tương ứng trong reup-desktop)

| File Node.js | Đã port sang | Ghi chú |
|---|---|---|
| `lib/extractor.js` (phần Facebook regex, SnapTikTok, TikWM) | `internal/adapters/downloader/{facebook,snaptiktok}.go` | Port 1-1, cùng regex |
| `lib/extractor.js` (`resolveUrl`, `cleanUrl`) | `internal/adapters/downloader/common.go` | Port 1-1 |
| `lib/browserHandler.js` (`sanitizeCookiesForPuppeteer`) | `internal/adapters/browser/cookies.go` (`ParseCookiesJSON`) | Port 1-1 |
| `lib/profiles.js` (khái niệm hồ sơ) | `internal/domain/models.go` (`Profile`) + `internal/adapters/storage/sqlite` | Đơn giản hoá, bỏ `user_id` (app 1 người dùng) |

## CHƯA port (vẫn chỉ có trong Node.js)

| File Node.js | Hàm | Vì sao chưa port |
|---|---|---|
| `lib/extractor.js` | `fetchDouyinDetailDirect` (ký `a_bogus`), `fetchDouyinDetail`/`fetchTikTokItemStruct` (qua Puppeteer) | Cần mở trình duyệt thật hoặc thuật toán ký request phức tạp — SnapTikTok/TikWM (đã port) đủ dùng phần lớn trường hợp, phần này chỉ là dự phòng khi 2 nguồn kia hỏng |
| `lib/videos.js` | Bảng `videos` dedup theo DB | Go dùng dedup đơn giản hơn: kiểm tra file `<platform>-<id>.mp4` đã tồn tại trên đĩa chưa |

## ⚠️ Bài học quan trọng từ việc debug app Node.js — CHƯA áp dụng cho app Go

Phiên làm việc trước đó đã dành nhiều thời gian sửa 1 bug nghiêm trọng ở `browserHandler.js`
(Facebook): code bấm NHẦM vào nút "Chia sẻ" của 1 bài viết khác trong News Feed nền phía sau, báo
"đăng thành công" nhưng THỰC RA CHƯA ĐĂNG GÌ CẢ. Xem lịch sử commit của
`tiktok-facebook-reuploader` quanh ngày 2026-09-12 để biết chi tiết đầy đủ (tìm commit
"sua loi bam nham nut Chia se").

App Go hiện tại (`internal/adapters/platforms/facebook/uploader.go`,
`internal/adapters/platforms/tiktok/uploader.go`) là code **gốc của uptik**, CHƯA áp dụng các bài
học này:

1. **Facebook (`facebook/uploader.go`)**: sau khi bấm nút đăng chỉ `time.Sleep(5s)` rồi TIN LUÔN
   là thành công — không xác nhận gì cả (giống bug cũ bên Node trước khi sửa). Nên áp dụng cách
   Node đang làm: đọc URL trình duyệt điều hướng tới ngay sau khi đăng (dạng
   `facebook.com/reel/<id>` — bằng chứng thật bài đã lên) thay vì tin mù.
2. **Khớp nút bấm không giới hạn phạm vi**: `facebook/uploader.go` tìm nút theo
   `document.querySelectorAll('button, [role="button"]')` trên TOÀN TRANG, dù đã khớp CHÍNH XÁC
   (`txt === 'Schedule'`...) chứ không khớp tiền tố như bug cũ, vẫn có rủi ro tương tự nếu trang có
   phần tử khác trùng chữ. Do dùng Meta Business Suite (ít "nhiễu" hơn News Feed cá nhân) nên rủi ro
   thấp hơn, nhưng CHƯA loại trừ hoàn toàn.
3. **TikTok (`tiktok/uploader.go`, 1013 dòng)**: đã có xác nhận thật (chờ redirect `/content` hoặc
   `/manage`, bắt modal thành công/lỗi) — tương đối ổn, gần giống tinh thần bản Node đã sửa.

**Khi nào cần quan tâm**: nếu sau khi đơn giản hoá xong UI, việc "đăng theo lịch" trên Facebook vẫn
báo thành công giả (giống hệt bug cũ bên Node) — đây chính là nguyên nhân, sửa theo đúng cách file
`browserHandler.js` ở thư mục này đã làm (tìm hàm `getLatestFacebookReelUrl` +
`FB_POST_CONFIRM_WAIT_MS` để xem cách Node xác nhận thật).
