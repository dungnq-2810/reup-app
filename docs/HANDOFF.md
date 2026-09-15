# Bàn giao — Reup Desktop (2026-09-14)

## Bối cảnh

App desktop Go (Wails + Svelte), fork từ [uptik](https://github.com/tymon5368/uptik) (MIT), mục
đích: tải video Douyin/TikTok/Facebook rồi đăng lại lên TikTok/Facebook bằng cookie, dùng 1 mình
(không multi-user/Telegram/backup như bản Node.js `tiktok-facebook-reuploader/` đang chạy song
song). Xem lịch sử đầy đủ trong `git log` — 5 commit đầu là bản gốc fork + các tính năng đã build.

**⚠️ QUAN TRỌNG — đọc `docs/reference-node-app/README.md` trước khi sửa bất cứ gì liên quan tới
tải video hoặc đăng bài.** Repo này (`reup-app`, https://github.com/dungnq-2810/reup-app) là repo
Git RIÊNG, tách khỏi project Node.js `tiktok-facebook-reuploader`
(https://github.com/dungnq-2810/tiktok-facebook-reuploader — repo GitHub khác, có sẵn trên tài
khoản `dungnq-2810`, clone về mà đọc trực tiếp nếu cần đối chiếu bản mới nhất, vì bản copy trong
`docs/reference-node-app/` chỉ là ảnh chụp cũ). Code Go ở đây **port lại logic từ chính project
Node.js đó**, và Node.js đó đã trải qua nhiều lần debug/sửa bug thực tế (đặc biệt là bug "báo đăng
thành công giả" trên Facebook) mà bản Go **CHƯA áp dụng các bài học đó**. `docs/reference-node-app/`
chứa bản sao các file Node.js liên quan + bảng "đã port / chưa port / bài học chưa áp dụng" — đọc
kỹ trước khi động vào `internal/adapters/downloader/` hoặc `internal/adapters/platforms/`.

### Cấu trúc repo này — cái gì là code THẬT, cái gì chỉ để THAM KHẢO

- **Code thật của app** (build/chạy được): `main.go`, `app.go`, `settings.go`, `internal/`,
  `frontend/` — mọi thứ NGOÀI thư mục `docs/`.
- **Chỉ để tham khảo, KHÔNG phải code của app này, KHÔNG được build**: toàn bộ `docs/` — gồm cả
  file `HANDOFF.md` này lẫn `docs/reference-node-app/` (bản copy tĩnh từ project Node.js khác, xem
  chi tiết ở `docs/reference-node-app/README.md`). Sửa app thì sửa trong `internal/`/`frontend/`,
  KHÔNG sửa gì trong `docs/reference-node-app/` (không có tác dụng, không ai chạy code đó cả).

**Sau khi dùng thử, thấy quá phức tạp.** Yêu cầu: **cắt bớt, chỉ giữ 3 việc**:
1. Đăng bài theo lịch (schedule)
2. Cấu hình cookie (Hồ sơ)
3. Danh sách link cần đăng

**Đã hỏi và chốt**: GIỮ cả 2 chế độ Hẹn giờ + Đăng ngay (không bỏ Publish Now).

## Đã cắt xong (2026-09-15)

- **Tab Matrix** (lịch 30 ngày) — xoá hẳn cả trigger lẫn nội dung.
- **Settings > System** (autoStart/closeToTray, code chết) — xoá.
- **Settings > Check Update** (chết hẳn từ khi bỏ backend updater) — xoá.
- **Settings > Channels/Omnichannel Targets** (trùng tab Hồ sơ) — xoá.
- **Header > Channel Toggles** (trùng #trên) — xoá.
- **Header > Quick Platform Open** (mở Chrome đăng nhập thủ công — không cần nữa vì đã dùng cookie qua tab Hồ sơ) — xoá.
- Dọn hết state/hàm/import chết đi kèm (`toggleChannel`, `handleOpenPlatform`, `handleOpenChrome`, `handleCheckUpdate`/`handleApplyUpdate`/`handleRestartApp`, `updateInfo` và các state liên quan, import `OpenChromeForLogin`/`OpenPlatformLogin`/`CheckPlatformLogin`/`GetAppVersion`).
- Đã build lại `wails build` thành công sau mỗi bước, `npm run check` 0 lỗi.

## Còn lại — chưa quyết định, để nguyên

- **Tab History**: vẫn giữ nguyên (không phải code chết, hiển thị lịch sử đăng thật) — có thể rút gọn sau nếu thấy còn rườm rà.
- **Tab Logs**: giữ nguyên (hữu ích debug cookie hỏng/lỗi đăng).
- **Quét thư mục local (`ScanFolder`/`SelectFolder`)**: CHƯA xoá — lưu ý `settings.videoFolder` đang dùng CHUNG cho 2 việc (thư mục quét local VÀ thư mục lưu video tải từ link), nên xoá tính năng quét thư mục cần cẩn thận không xoá nhầm field lưu trữ. Muốn xoá thì: bỏ nút "Chọn thư mục"/`SelectFolder` + nút quét lại, giữ nguyên `settings.videoFolder` làm nơi lưu file tải về.
- **Bảng "Channels" hiển thị trong Queue/History** (`platforms.find(p => p.id === ch)`): từ khi đổi `ch` sang là Profile ID thay vì tên nền tảng cố định, các badge này sẽ không tìm thấy icon/màu đúng nữa (hiện fallback về hiển thị chữ thô) — cosmetic, không phải lỗi chức năng, có thể sửa sau bằng cách tra theo danh sách `profiles` thay vì `platforms`.
- Chưa dọn field không còn dùng trong `internal/domain/models.go` (`Settings.AutoStart/CloseToTray/StartHidden/ChromeUserDataDir`) — để nguyên cũng không sao vì không còn UI nào đọc/ghi, chỉ là field thừa trong struct.

## Trạng thái kỹ thuật hiện tại (đã xong, chạy được)

- `go build/vet/test ./...` sạch. `npm run check`/`npm run build` sạch. **`wails build` chạy thật
  thành công**, ra `build/bin/reup-desktop.exe` (đã tự mở lên chạy thử được, cửa sổ "Reup Desktop"
  hiện ra bình thường).
- Môi trường Go/Wails CLI cài ở `D:\dev\go` và `D:\dev\gopath` (không đụng ổ C) — máy khác (công
  ty) cần cài lại Go 1.26+, Node 20+, `go install github.com/wailsapp/wails/v2/cmd/wails@v2.15.0`.
- Cấu trúc code chính: `app.go` (Wails-bound methods), `internal/domain` (model), `internal/ports`
  (interface), `internal/adapters/{platforms,storage/sqlite,queue,downloader,browser}`
  (implementation), `internal/usecases` (nghiệp vụ), `frontend/src/App.svelte` (UI, ~2800 dòng,
  1 file duy nhất).
- Giới hạn đã biết: Douyin/TikTok chỉ tải qua SnapTikTok + TikWM (chưa có nhánh Puppeteer/go-rod dự
  phòng khi 2 nguồn này thất bại).

## Việc cho phiên Claude Code tiếp theo

Đọc file này TRƯỚC, rồi đọc `docs/reference-node-app/README.md` (bảng đã-port/chưa-port + bài học
từ app Node.js chưa áp dụng cho app Go). Sau đó có thể bắt đầu ngay bằng cách hỏi Claude Code:
*"đọc docs/HANDOFF.md và docs/reference-node-app/README.md, thực hiện phần 'Việc cần làm tiếp' —
cắt tab Matrix, dọn Settings"*. Nên vào Plan mode trước khi sửa vì đụng tới nhiều chỗ trong file
`App.svelte` 2800 dòng.
