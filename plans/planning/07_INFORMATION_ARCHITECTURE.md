# 🗺️ 07. Kiến Trúc Thông Tin, Sitemap & Danh Mục Màn Hình (Screen Inventory)

Tài liệu này xác định sơ đồ cấu trúc trang (Sitemap), luồng điều hướng và danh mục màn hình chi tiết cho cả **Web Client** và **Mobile Flutter App**.

---

## 1. SƠ ĐỒ CẤU TRÚC TRANG WEB (WEB SITEMAP)

```
/ (Trang Chủ: Slider HOT, Mới cập nhật, BXH)
├── /explore (Bộ lọc tìm kiếm đa tiêu chí)
├── /manga (Chuyên trang truyện tranh)
├── /novels (Chuyên trang truyện chữ / Light Novel)
├── /rankings (Bảng xếp hạng Ngày/Tuần/Tháng/All-time)
├── /search (Tìm kiếm nhanh với từ khóa & suggestions)
├── /story/:slug (Chi tiết bộ truyện, tác giả, danh sách Volume/Chapter)
│   ├── /story/:slug/illustrations (Bộ sưu tập ảnh minh họa)
│   └── /story/:slug/chapter/:chapterNumber (Trình đọc Manga / Novel)
├── /auth/login (Màn hình / Modal Đăng Nhập)
├── /auth/register (Màn hình / Modal Đăng Ký)
├── /auth/forgot-password (Khôi phục mật khẩu)
├── /library (Tủ sách cá nhân: Đang đọc, Đã đọc xong, Theo dõi)
├── /history (Lịch sử các chương đã đọc)
├── /gamification (Trung tâm Gamification: Level, OmniCoin, Rank Themes)
│   ├── /gamification/checkin (Điểm danh hàng ngày & Lịch Streak)
│   ├── /gamification/missions (Danh sách Nhiệm vụ Ngày/Tuần)
│   └── /gamification/ledger (Sổ cái Lịch sử biến động số dư)
├── /studio (Xưởng sáng tác & Dịch thuật dành cho Creator/Translator)
│   ├── /studio/stories (Danh sách truyện quản lý)
│   ├── /studio/stories/new (Tạo bộ truyện mới & Ấn bản)
│   ├── /studio/stories/:id/chapters (Quản lý các chương & version)
│   ├── /studio/stories/:id/upload (Upload ZIP ảnh / File Text)
│   └── /studio/ai/jobs/:jobId (Màn hình tiến trình dịch, Diff Preview & Popup xuất bản)
├── /profile (Quản lý tài khoản, đổi mật khẩu, avatar)
└── /admin (Khu vực Quản trị viên)
    ├── /admin/users (Quản lý tài khoản & phân quyền)
    ├── /admin/reports (Xử lý báo lỗi chương & khiếu nại)
    └── /admin/analytics (Thống kê lượt đọc, lưu lượng MinIO, Token AI)
```

---

## 2. DANH MỤC MÀN HÌNH WEB CHI TIẾT (WEB SCREEN INVENTORY)

| Mã Màn Hình | Tên Màn Hình | Mô Tả Chức Năng Chính | API Endpoints Liên Quan |
| :--- | :--- | :--- | :--- |
| **WEB-001** | Trang Chủ (Home Feed) | Slider HOT, Truyện mới cập nhật, BXH Top Views | `GET /api/v1/stories/featured`, `GET /api/v1/stories/recent` |
| **WEB-002** | Khám Phá & Bộ Lọc (Explore) | Lọc thể loại, định dạng, tình trạng, quốc gia | `GET /api/v1/stories?genre=...&format=...` |
| **WEB-003** | Chi Tiết Bộ Truyện (Story Detail)| Tóm tắt, tác giả, danh mục Ấn bản/Tập/Chương | `GET /api/v1/stories/:slug` |
| **WEB-004** | Trình Đọc Manga (Manga Reader) | Đọc cuộn Webtoon, lật trang Manga, đổi Server CDN, đổi Version | `GET /api/v1/chapters/:id` |
| **WEB-005** | Trình Đọc Tiểu Thuyết (Novel Reader)| Chỉnh font, nền Sepia/Dark OLED, mục lục trượt, ảnh minh họa | `GET /api/v1/chapters/:id` |
| **WEB-006** | Xác Thực (Auth Modal/Page) | Đăng nhập, Đăng ký tài khoản, Quên mật khẩu | `POST /api/v1/auth/login`, `POST /api/v1/auth/register` |
| **WEB-007** | Tủ Sách Cá Nhân (Library & History)| Xem truyện theo dõi, truyện đang đọc dở, lịch sử | `GET /api/v1/library`, `GET /api/v1/library/progress` |
| **WEB-008** | Trung Tâm Gamification (Gamification)| Xem Level, thanh tiến trình EXP, chọn Rank Theme | `GET /api/v1/gamification/progression`, `PATCH /.../rank-theme` |
| **WEB-009** | Điểm Danh & Nhiệm Vụ (Daily Checkin)| Lịch điểm danh tháng, nhận thưởng chuỗi streak | `POST /api/v1/gamification/checkin` |
| **WEB-010** | Sổ Cái Biến Động Số Dư (Ledger History)| Tra cứu toàn bộ lịch sử cộng/trừ EXP và OmniCoin | `GET /api/v1/gamification/transactions` |
| **WEB-011** | Studio - Quản Lý Truyện (Studio Stories)| Danh sách tác phẩm quản lý, tạo ấn bản StoryEdition | `GET /api/v1/studio/stories`, `POST /api/v1/studio/stories` |
| **WEB-012** | Studio - Tải Lên Chương (Chapter Upload)| Kéo thả file ZIP ảnh Manga / File Text Novel | `POST /api/v1/uploads/sessions` |
| **WEB-013** | Studio - Tiến Trình Dịch AI (AI Progress)| Theo dõi % OCR/Dịch/Inpaint qua WebSocket | `GET /api/v1/ai/jobs/:id`, WebSocket Gateway |
| **WEB-014** | Studio - Diff Preview & Popup Xuất Bản| So sánh ảnh trước/sau và chọn Ghi đè / Nhân bản | `POST /api/v1/ai/jobs/:id/apply` |
| **WEB-015** | Admin - Báo Lỗi & Kiểm Duyệt (Admin Hub) | Quản lý báo lỗi chương, phân quyền người dùng, takedown | `GET /api/v1/admin/reports`, `PATCH /api/v1/admin/users/:id` |

---

## 3. DANH MỤC MÀN HÌNH MOBILE FLUTTER (MOBILE SCREEN INVENTORY)

| Mã Màn Hình | Tên Màn Hình | Mô Tả Chức Năng Chính | API Endpoints Liên Quan |
| :--- | :--- | :--- | :--- |
| **MOB-001** | Mobile Home Feed | Tabs: Đề cử HOT, Mới cập nhật, BXH Top Views | `GET /api/v1/stories/featured` |
| **MOB-002** | Mobile Search & Suggestions | Thanh tìm kiếm tức thì có gợi ý kèm bộ lọc nhanh | `GET /api/v1/stories/search` |
| **MOB-003** | Mobile Story Detail | Trang chi tiết truyện, Bottom Sheet chọn tập/chương | `GET /api/v1/stories/:slug` |
| **MOB-004** | Mobile Webtoon Reader | Trình đọc cuộn dọc tối ưu 120Hz, RAM $< 150MB$ | `GET /api/v1/chapters/:id` |
| **MOB-005** | Mobile Manga Paged Reader | Trình đọc lật trang phải $\rightarrow$ trái, phóng to pinch-zoom | `GET /api/v1/chapters/:id` |
| **MOB-006** | Mobile Novel Reader | Trình đọc truyện chữ, menu tùy biến Typography | `GET /api/v1/chapters/:id` |
| **MOB-007** | Mobile Illustration Gallery | Xem bộ sưu tập ảnh minh họa của tập truyện | `GET /api/v1/chapters/:id` |
| **MOB-008** | Mobile Auth & Account | Đăng nhập/Đăng ký, quản lý phiên đăng nhập | `POST /api/v1/auth/login` |
| **MOB-009** | Mobile Library & Saved Progress| Tủ sách cá nhân, nút "Đọc tiếp" mở đúng vị trí | `GET /api/v1/library/progress` |
| **MOB-010** | Mobile Gamification & Check-in | Điểm danh nhận Coin, xem Level, chọn Rank Theme | `POST /api/v1/gamification/checkin` |
| **MOB-011** | Mobile Error Reporting Sheet | Bottom Sheet báo lỗi chương nhanh cho độc giả | `POST /api/v1/chapters/:id/reports` |
| **MOB-012** | Mobile Offline Download Manager | Quản lý các chương đã tải đọc offline (V1 Scope)| CSDL SQLite Cục Bộ |
