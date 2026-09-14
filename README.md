# Reup Desktop

App desktop cá nhân (Windows) để tải video từ Douyin/TikTok/Facebook và đăng lại lên TikTok/Facebook
bằng cookie đã đăng nhập sẵn, có hẹn giờ và đăng hàng loạt.

Fork từ [uptik](https://github.com/tymon5368/uptik) (MIT license) — xem `LICENSE`.

## Khác gì so với uptik gốc

- **Nguồn video**: dán link Douyin/TikTok/Facebook để tự tải về, thay vì tự tải video vào 1 thư
  mục rồi quét (`ScanFolder` vẫn còn, dùng song song được).
- **Đăng bài bằng cookie**: mỗi "Hồ sơ" (tab Hồ sơ) là 1 tài khoản riêng với cookie JSON dán sẵn,
  đăng qua ngữ cảnh trình duyệt cô lập (không dùng chung 1 Chrome profile đăng nhập thật) — hỗ trợ
  nhiều tài khoản cùng nền tảng cùng lúc.
- **Hẹn giờ**: giữ nguyên cơ chế "Golden Hour" của uptik — chọn "Hẹn giờ" trên chính giao diện
  TikTok/Facebook, nền tảng tự giữ và tự đăng đúng giờ.
- Đã bỏ: YouTube, tự động cập nhật, system tray, tự khởi động cùng hệ thống (không cần cho app cá
  nhân chạy 1 mình).

## Yêu cầu

- [Go](https://go.dev/dl/) 1.26+
- [Node.js](https://nodejs.org/) 20+ (dùng npm — không cần bun)
- [Wails CLI](https://wails.io/) v2.15.0: `go install github.com/wailsapp/wails/v2/cmd/wails@v2.15.0`
- Windows 10/11 (đã có sẵn WebView2 Runtime)

## Chạy thử (dev, có hot-reload)

```
wails dev
```

## Build ra file .exe

```
wails build
```

File chạy được nằm ở `build/bin/reup-desktop.exe`.

## Sử dụng

1. Mở tab **Hồ sơ** → thêm hồ sơ: đặt tên, chọn nền tảng, dán cookie JSON đã đăng nhập sẵn (xuất
   bằng extension như Cookie-Editor).
2. Ở tab **Queue**, dán link Douyin/TikTok/Facebook vào ô rồi bấm **Tải video**.
3. Quay lại tab Hồ sơ, tick chọn (các) hồ sơ muốn đăng.
4. Bấm **Bắt đầu đăng** — có thể hẹn giờ hoặc đăng ngay tuỳ chế độ đã chọn ở Cài đặt.

## Giới hạn hiện tại

- Douyin/TikTok chỉ dùng đường tải qua SnapTikTok (+ TikWM dự phòng cho TikTok) — chưa có nhánh mở
  trình duyệt thật để lấy bản gốc khi 2 nguồn trên thất bại (Douyin cần đăng nhập/bị chặn tạm sẽ
  báo lỗi thay vì tự thử cách khác).
