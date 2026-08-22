# 🗺️ 07. Kiến Trúc Thông Tin, Sitemap & Danh Mục Màn Hình (Screen Inventory)

Tài liệu này xác định sơ đồ cấu trúc trang (Sitemap), luồng điều hướng và danh mục màn hình chi tiết cho cả **Web** và **Mobile App**.

---

## 1. SƠ ĐỒ CẤU TRÚC TRANG WEB (WEB SITEMAP)

```
/ (Trang Chủ: Slider HOT, Mới cập nhật, BXH)
├── /explore (Bộ lọc tìm kiếm đa tiêu chí)
├── /manga (Chuyên trang truyện tranh)
├── /novels (Chuyên trang truyện chữ / Light Novel)
├── /rankings (Bảng xếp hạng Ngày/Tuần/Tháng/All-time)
├── /search (Tìm kiếm nhanh với từ khóa)
├── /story/:slug (Chi tiết bộ truyện, tác giả, danh sách volume/chapter)
│   ├── /story/:slug/illustrations (Bộ sưu tập ảnh minh họa)
│   └── /story/:slug/chapter/:chapterNumber (Trình đọc Manga / Novel)
├── /library (Tủ sách cá nhân: Đang đọc, Đã đọc xong, Theo dõi)
├── /history (Lịch sử các chương đã đọc)
├── /studio (Xưởng sáng tác & Dịch thuật dành cho Creator/Uploader)
│   ├── /studio/stories (Danh sách truyện quản lý)
│   ├── /studio/stories/new (Tạo bộ truyện mới)
│   ├── /studio/stories/:id/chapters (Quản lý các chương)
│   ├── /studio/stories/:id/upload (Upload ZIP ảnh / File Text)
│   └── /studio/ai/jobs/:jobId (Màn hình tiến trình dịch & Popup 2 phương án)
├── /profile (Quản lý tài khoản, đổi mật khẩu, avatar)
└── /admin (Khu vực Quản trị viên)
    ├── /admin/users (Quản lý tài khoản & phân quyền)
    ├── /admin/reports (Xử lý báo lỗi chương)
    └── /admin/analytics (Thống kê lượt đọc, lưu lượng MinIO, Token AI)
```

---

## 2. DANH MỤC MÀN HÌNH (SCREEN INVENTORY)

| Mã Màn Hình | Tên Màn Hình | Thiết Bị | Mô Tả Chức Năng Chính | API Liên Quan |
| :--- | :--- | :---: | :--- | :--- |
| **WEB-001** | Trang Chủ (Home) | Web | Slider HOT, Truyện mới, BXH Top Views | `GET /api/v1/stories/featured`, `GET /api/v1/stories/recent` |
| **WEB-002** | Khám Phá & Bộ Lọc | Web | Lọc thể loại, tình trạng, quốc gia | `GET /api/v1/stories?genre=...` |
| **WEB-003** | Chi Tiết Bộ Truyện | Web | Tóm tắt, tác giả, danh sách Volume/Chapter | `GET /api/v1/stories/:slug` |
| **WEB-004** | Trình Đọc Manga | Web | Đọc cuộn/lật, chọn server CDN, đổi bản dịch | `GET /api/v1/chapters/:id` |
| **WEB-005** | Trình Đọc Light Novel | Web | Chỉnh font, nền Sepia/Dark, mục lục trượt | `GET /api/v1/chapters/:id` |
| **WEB-006** | Studio Upload | Web | Kéo thả file ZIP/Text, kích hoạt dịch AI | `POST /api/v1/chapters/upload` |
| **WEB-007** | AI Preview & Popup | Web | So sánh bản dịch và chọn Ghi đè/Nhân bản | `POST /api/v1/ai/apply-option` |
| **MOB-001** | Home Feed | Mobile | Giao diện trang chủ tối ưu cảm ứng | `GET /api/v1/stories/featured` |
| **MOB-002** | Mobile Webtoon Reader| Mobile | Cuộn dọc 120Hz mượt mà, bộ nhớ RAM < 150MB | `GET /api/v1/chapters/:id` |
| **MOB-003** | Offline Manager | Mobile | Quản lý các chương đã tải về máy | Local SQLite Database |
