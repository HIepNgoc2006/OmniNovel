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
├── /studio (Xưởng dịch thuật & Quản lý ấn bản dành cho Translator/Editor)
│   ├── /studio (Dashboard quản lý Story, Project, Realtime Jobs & Metrics - #145)
│   ├── /studio/ai/jobs/new (Tạo Translation Job mới, chọn version, consent & idempotency - #146)
│   └── /studio/ai/jobs/:jobId (Unified Format-Aware Review Studio)
│       ├── Manga Review Studio: Canvas Bounding Box, Segment OCC Editor, Re-render Lifecycle (#149)
│       ├── Novel Review Studio: AST Block Grouping, Protected Anchor Tokenizer, OCC Verification (#150)
│       ├── Modal Quản lý Thuật ngữ Dịch (Live Project Glossary vs Job Snapshot - #151)
│       └── Modal Xuất bản Chương: Ghi đè Active Version vs Tạo Version phụ (#152)
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
| **WEB-011** | Studio - Tổng Quan Dashboard | Metrics thẻ tiến độ, bộ chọn Story, bảng lọc multi-status, card danh sách job realtime | `GET /api/v1/studio/stories`, `GET /api/v1/ai/jobs`, WebSocket `/ws/ai` |
| **WEB-012** | Studio - Tạo Job Dịch Mới | Chọn Story/Edition/Chapter Version, cảnh báo & consent external provider, idempotency key cố định | `GET /api/v1/studio/chapters/:id/versions`, `POST /api/v1/ai/jobs` |
| **WEB-013** | Studio - Trình Duyệt Manga Review | Canvas Bounding Box ảnh gốc/dịch, thanh điều hướng trang bounded, Segment OCC Editor, Re-render Materialization Lifecycle | `GET /api/v1/ai/jobs/:id`, `GET /api/v1/ai/jobs/:id/previews`, `GET /api/v1/ai/jobs/:id/segments`, `PATCH /.../segments/:id`, `POST /.../materializations` |
| **WEB-014** | Studio - Trình Duyệt Novel Review | Danh sách AST blocks theo nhóm, Tokenizer thẻ bảo vệ `⟦...⟧`, kiểm tra topology client/server, Save OCC & duyệt tiến độ | `GET /api/v1/ai/jobs/:id`, `GET /api/v1/ai/jobs/:id/segments`, `PATCH /.../segments/:id`, `POST /.../materializations` |
| **WEB-014A**| Studio - Modal Xuất Bản Chương | So sánh và lựa chọn chiến lược Ghi đè Active Version vs Tạo Version phụ, kiểm tra Freshness Gate | `POST /api/v1/ai/jobs/:id/apply` |
| **WEB-014B**| Studio - Modal Thuật Ngữ Dịch | Quản lý Live Project Glossary (thêm/sửa/chuẩn hóa) và tra cứu snapshot thuật ngữ bất biến của Job | `GET /api/v1/ai/glossary`, `POST /api/v1/ai/glossary` |
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
