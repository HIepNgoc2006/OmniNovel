# 📋 Phase 4: Giao Diện Web Đọc Truyện & AI Translation Studio (phase_04_web_client.md)

- **Mục tiêu:** Xây dựng ứng dụng Web đọc truyện chuyên nghiệp (Next.js 16.3.3 App Router, React 19.2, Tailwind CSS 4.3) kết hợp giữa phong cách hiện đại của TruyenQQ (Manga 120Hz, cuộn mượt, CDN selector) và DocLN (Light Novel tùy biến theme Sepia/Dark, Ruby rendering, mục lục drawer), đồng thời tích hợp Studio quản lý đăng tải & dịch thuật AI thời gian thực.
- **Kiến Trúc Giao Diện & Trạng Thái (Architecture SSoT):**
  - **Monorepo App:** `apps/web` (Next.js 16.3.3 Active LTS, React 19.2, Node >=20.9.0, Tailwind CSS 4.3 CSS-first architecture via PostCSS).
  - **Phân Tách Theme Rõ Ràng (Theme Engine):**
    - **Application Site Theme (`siteTheme`):** `"dark" | "light" | "system"` (Dark Mode mặc định Slate `#0f172a`, Text `#f8fafc`, Accent Vermillion `#dc2626`, Glassmorphic Header).
    - **Reader Content Theme (`readerTheme`):** `"dark" | "light" | "sepia"` (Sepia chỉ áp dụng bên trong khung đọc Light Novel/Manga, không áp dụng toàn site).
  - **Kiến Trúc Auth & Bảo Mật:**
    - Refresh Token lưu trong `HttpOnly Secure SameSite=Strict` Cookie do Core API cấp tại `Path=/api/v1/auth`.
    - Access Token lưu hoàn toàn trong **Memory-Only Token Store** (RAM), không lưu vào `localStorage` hay persisted state.
    - Single-Flight Interceptor xử lý triệt để race conditions khi nhiều request đồng thời gặp HTTP 401.
    - Phân quyền: `proxy.ts` (Next 16) phục vụ optimistic UX redirects; `AuthBoundary` kiểm tra session client; NestJS Guards là chốt chặn bảo mật authoritative.
  - **Networking & Server State:**
    - TanStack Query v5 quản lý Server State & SWR Caching.
    - WebSocket Gateway (`/ws/ai`) xác thực qua `socket.handshake.auth.token` và tự động reconnect khi token xoay vòng.
    - Gamification: Tiêu thụ endpoint chuẩn `/gamification/progression` và `UserProgressionResponse` từ `@omninovel/shared`.
- **Trạng thái:** [/] Đang thực hiện (Phase 4A: 100% HOÀN TẤT & FROZEN - 8/8 Vitest Tests Passed - Build & Lint Green)

---

### Danh Sách Phân Đoạn & Đầu Việc (Checklist):

- [x] **Phase 4A: Web Foundation, Design System & Auth/State Core (100% HOÀN TẤT & FROZEN - 8/8 Tests Passed)**
  - [x] Khởi tạo dự án Next.js 16.3.3 + React 19.2 trong `apps/web`, cấu hình TypeScript 5.6+, Tailwind CSS 4.3 CSS-first.
  - [x] Xây dựng Theme Engine phân tách `siteTheme` (dark, light, system) và `readerTheme` (dark, light, sepia) với `localStorage` persistence.
  - [x] Xây dựng Memory-Only Auth Store & API Client SDK với Single-Flight 401 Refresh Interceptor.
  - [x] Xây dựng Auth Context & Session Hydration Provider (Login/Register modal tabs, Route Guards, User Profile, Level/EXP/OmniCoin).
  - [x] Xây dựng App Shell chuẩn SEO (Server Component `layout.tsx`, Client `providers.tsx`, Header với Mega Search & Gamification Badge, Footer, Mobile Bottom Bar).
  - [x] Xây dựng WebSocket Hook kết nối `/ws/ai` lắng nghe tiến trình TranslationJob kèm cơ chế token rotation reconnect.
  - [x] Thiết lập hạ tầng kiểm thử Vitest (8/8 Unit/Component Tests Green 100%), Playwright E2E and Next.js Production Build.

- [ ] **Phase 4B: Discovery, Catalog & Story Details (TruyenQQ & DocLN Showcase)**
  - [ ] Xây dựng Trang chủ: Hero Carousel Slider truyện HOT, Danh sách mới cập nhật, Bảng xếp hạng Top ngày/tuần/tháng.
  - [ ] Xây dựng Trang lọc & tìm kiếm nâng cao (Multi-criteria filter: Manga/Novel, Thể loại, Trạng thái hoàn thành, Sắp xếp).
  - [ ] Xây dựng Trang chi tiết truyện: Thông tin bộ truyện, Danh sách chương, Đánh dấu yêu thích / Lịch sử đọc, Bộ chọn phiên bản chương (`RAW_ORIGINAL`, `AI_TRANSLATED`, `HUMAN_EDITED`).
  - [ ] Tích hợp hệ thống Bình luận & Đánh giá phân cấp kèm Huy hiệu Gamification.

- [ ] **Phase 4C: Multimodal Reader Experience (Manga 120Hz & Light Novel Customizer)**
  - [ ] Manga Reader: Chế độ cuộn dọc (Webtoon mode), lật trang ngang RTL/LTR, bộ chọn máy chủ CDN, phím tắt điều hướng.
  - [ ] Light Novel Reader: Bộ tùy biến giao diện (Font Serif/Sans, cỡ chữ, khoảng cách dòng, lề trang), render thẻ Ruby chuẩn semantic (`<ruby><rb>...<rt>...`), Mục lục Drawer nhanh.
  - [ ] Đồng bộ hóa vị trí đọc tự động lên Server API và hỗ trợ Offline Local Caching.

- [ ] **Phase 4D: AI Translation Studio & Apply Management**
  - [ ] Studio Dashboard: Danh sách Translation Projects, Bảng theo dõi tiến độ Job thời gian thực qua WebSocket `/ws/ai` (14 stages).
  - [ ] Manga Translation Studio: Trình xem ảnh gốc vs ảnh đã dịch, xem vùng nhận diện thoại OCR, chỉnh sửa bản dịch từng ô thoại.
  - [ ] Novel Translation Studio: Trình đối chiếu AST đoạn văn bản song ngữ, đánh dấu thuật ngữ Glossary, kiểm tra protected inline tags (`⟦...⟧`).
  - [ ] Modal xuất bản chương: Lựa chọn 2 chiến lược `OVERWRITE_ACTIVE_VERSION` vs `CREATE_ALTERNATE_VERSION` kèm preview trực quan.
