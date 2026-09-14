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

**Sau khi dùng thử, thấy quá phức tạp.** Yêu cầu mới: **cắt bớt, chỉ giữ 3 việc**:
1. Đăng bài theo lịch (schedule)
2. Cấu hình cookie (Hồ sơ)
3. Danh sách link cần đăng

Mọi thứ khác coi là thừa, cần dọn bớt.

## Hiện trạng UI (6 tab) — cái nào giữ, cái nào bỏ

| Tab | Nội dung hiện tại | Đề xuất |
|---|---|---|
| **Queue** | Danh sách video, ô dán link tải về, nút chọn thư mục quét local, filter/search, grid/list view, widget "Auto Upload Scheduler" | **Giữ** phần lõi (danh sách link + trạng thái), **bỏ** filter/search/2 chế độ view (thừa cho vài chục link), cân nhắc bỏ luôn quét thư mục local (`ScanFolder`/`SelectFolder`) nếu không dùng — chỉ cần dán link |
| **Hồ sơ** (mới thêm) | Thêm/xoá hồ sơ (tên, nền tảng, cookie JSON), tick chọn hồ sơ dùng khi đăng | **Giữ nguyên** — đúng thứ 2 trong 3 việc cần |
| **Matrix** (30-day calendar) | Bảng lịch 30 ngày x khung giờ vàng, xem trước video nào vào slot nào | **Bỏ** — phức tạp không cần thiết nếu chỉ cần "đăng theo lịch" đơn giản |
| **History** | Lịch sử đã đăng thành công | Cân nhắc **giữ rút gọn** (chỉ 1 bảng đơn giản) hoặc gộp vào Queue (video đã xong vẫn hiện, đổi trạng thái) |
| **Logs** | Console log real-time | **Giữ** (hữu ích để debug khi cookie hỏng/lỗi đăng), có thể thu nhỏ lại |
| **Settings** | Language, General (thư mục video/Chrome path/headless/CDP port), System (**còn sót autoStart/closeToTray — code chết, không có tác dụng gì cả vì đã bỏ tray/updater ở backend**), Check Update (**chết hẳn, nút không làm gì**), Publish Mode, TikTok Restricted Policy, Golden Hours (2 bộ giờ riêng cho Schedule/Publish Now), Channels (**tên cũ, giờ vô nghĩa — đã thay bằng tab Hồ sơ**) | **Cắt mạnh**: bỏ System (autoStart/closeToTray chết), bỏ hẳn khối Check Update (chết), bỏ khối "Channels" cũ (trùng chức năng với tab Hồ sơ), cân nhắc gộp Golden Hours thành 1 bộ giờ duy nhất thay vì tách Schedule/Publish Now nếu không cần 2 chế độ |

## Việc cần làm tiếp (chưa làm)

1. **Xoá tab Matrix** hoàn toàn (UI + `internal/usecases/schedule_slots.go` nếu không cần slot-assignment phức tạp nữa — có thể thay bằng: mỗi link tự chọn ngày/giờ đơn giản, không cần thuật toán rải khung giờ vàng).
2. **Dọn Settings**: xoá phần System (autoStart/closeToTray — đã chết), xoá phần Check Update (đã chết, đã vô hiệu hoá logic nhưng UI còn hiện nút vô dụng), xoá phần "Channels" cũ (`settings.enabledChannels` không còn dùng thật từ khi có tab Hồ sơ — kiểm tra kỹ trước khi xoá field này khỏi `domain.Settings` vì `GenerateSlots`/mặc định vẫn đọc nó ở vài chỗ).
3. **Quyết định giữ hay bỏ**: quét thư mục local (`ScanFolder`), 2 chế độ Schedule/Publish Now riêng biệt, tab History (gộp hay giữ riêng).
4. Sau khi cắt xong, review lại `internal/domain/models.go` (Settings struct) xoá nốt field không còn UI nào đọc/ghi.

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
