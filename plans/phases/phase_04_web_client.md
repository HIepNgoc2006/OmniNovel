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
- **Trạng thái:** [/] Đang thực hiện (Phase 4A, Phase 4B & Phase 4C: 100% HOÀN TẤT - 33 Vitest + 14 Playwright + 139 Core API [22 Unit + 117 E2E/Integration] + 184 AI Worker = 370 Total CI Tests Pass 100%)

---

### Danh Sách Phân Đoạn & Đầu Việc (Checklist):

- [x] **Phase 4A: Web Foundation, Design System & Auth/State Core (100% HOÀN TẤT & FROZEN)**
  - [x] Khởi tạo dự án Next.js 16.3.3 + React 19.2 trong `apps/web`, cấu hình TypeScript 5.6+, Tailwind CSS 4.3 CSS-first.
  - [x] Xây dựng Theme Engine phân tách `siteTheme` (dark, light, system) và `readerTheme` (dark, light, sepia) với `localStorage` persistence.
  - [x] Xây dựng Memory-Only Auth Store & API Client SDK với Single-Flight 401 Refresh Interceptor (Canonical port 8000).
  - [x] Chuẩn hóa Auth Contract (`{ identifier, password }`, `{ user: { id, username, email, role, avatarUrl }, permissions: UserPermissions }`, `minLength={8}`).
  - [x] Xây dựng Auth Context & Session Hydration Provider (Login/Register modal tabs, Route Guards, User Profile, Level/EXP/OmniCoin).
  - [x] Xây dựng App Shell chuẩn SEO (Server Component `layout.tsx`, Client `providers.tsx`, Header với Mega Search & Gamification Badge, Footer, Mobile Bottom Bar).
  - [x] Xây dựng WebSocket Hook kết nối `/ws/ai` lắng nghe tiến trình TranslationJob ({ jobId, stage, progress, timestamp }) kèm cơ chế active token rotation reconnect.
  - [x] Thiết lập hạ tầng kiểm thử Vitest (9/9 Unit/Component Tests Green 100%), Playwright Browser E2E Smoke Suite (4/4 Tests Green with Mocked Canonical Core API), và Next.js Production Build.

- [x] **Phase 4B: Discovery, Catalog, Story Details & Idempotent Bookmarks (100% HOÀN TẤT & FROZEN - 20 Vitest + 7 Playwright + 91 app.e2e-spec / 137 Core Tests)**
  - [x] Xây dựng Trang chủ: Hero Carousel Slider truyện HOT, Danh sách mới cập nhật, Bảng xếp hạng Top truyện có lượt xem cao nhất toàn thời gian, Widget điểm danh hàng ngày.
  - [x] Xây dựng Trang lọc & tìm kiếm nâng cao (Multi-criteria filter: Manga/Novel, Thể loại canonical slugs, Trạng thái hoàn thành, Sắp xếp canonical LATEST/VIEWS/POPULAR, Phân trang).
  - [x] Xây dựng Trang chi tiết truyện: Thông tin bộ truyện, Danh sách chương, Đánh dấu theo dõi / Tủ sách (`POST /api/v1/library/bookmarks`), Bộ chọn phiên bản chương (`RAW_ORIGINAL`, `AI_TRANSLATED`, `HUMAN_EDITED`).
  - [x] Hardening Core API Discovery: Runtime DTO validation `FindStoriesQueryDto`, Idempotent Bookmark state machine (`POST /api/v1/library/bookmarks`), Canonical `latestChapter` projection (chỉ chapter đã xuất bản của default edition), Canonical `sort=LATEST` theo thời gian xuất bản chương mới nhất của default edition, Trigram & index migration `1700000000006-AddStoryDiscoveryIndexes`.
  - [x] Giao diện Bình luận & Thảo luận phân cấp (Comment / Discussion UI Prototype, Persistence API deferred to Community Phase).

- [x] **Phase 4C: Multimodal Reader Experience (Manga 120Hz & Light Novel Customizer) (100% HOÀN TẤT - 33 Vitest + 14 Playwright + 139 Core API Tests)**
  - [x] Tách biệt Layout Route Groups: `app/layout.tsx` (Root shell), `(site)/layout.tsx` (Header/Footer cho public/protected/studio), `(reader)/layout.tsx` (Clean Fullscreen Reader Shell).
  - [x] Manga Reader Engine: Chế độ cuộn dọc 120Hz (Webtoon mode), lật trang ngang Paged RTL (phải sang trái chuẩn manga Nhật) & LTR, Smart Reading HUD tự động ẩn/hiện, bàn phím điều hướng (ArrowLeft, ArrowRight, F, M).
  - [x] Light Novel Reader Engine: Tùy biến giao diện (Theme Sepia/Dark/Light, Font Serif/Sans, cỡ chữ 14-28px, khoảng cách dòng 1.4-2.4x, căn lề left/justify, khung đọc narrow/standard/wide), render an toàn thẻ Ruby (`<ruby><rb>...<rt>...`), Tooltip chú thích (Footnote popover).
  - [x] Bảo mật & An toàn nội dung: Bộ lọc HTML Sanitizer nghiêm ngặt (chỉ cho phép thẻ/thuộc tính trong allowlist, chặn toàn bộ script/iframe/event handlers và XSS).
  - [x] Đồng bộ tiến độ đọc & Gamification: Hook `useReadingProgress` đo thời gian đọc thực tế, tự động đồng bộ lên Server `PUT /api/v1/library/reading-progress` (Debounced) kèm fallback IndexedDB offline cache, tự động kích hoạt nhận thưởng +5 EXP khi đạt điều kiện (>=45s đọc & >=80% hoàn thành).
  - [x] Bộ chọn phiên bản bản dịch (`VersionSelectorModal`) và Ngăn kéo mục lục nhảy chương nhanh (`ChapterDrawer`) tích hợp thanh tìm kiếm và đánh dấu đã đọc.

- [ ] **Phase 4D: AI Translation Studio & Apply Management**
  - [ ] Studio Dashboard: Danh sách Translation Projects, Bảng theo dõi tiến độ Job thời gian thực qua WebSocket `/ws/ai` (14 stages).
  - [ ] Manga Translation Studio: Trình xem ảnh gốc vs ảnh đã dịch, xem vùng nhận diện thoại OCR, chỉnh sửa bản dịch từng ô thoại.
  - [ ] Novel Translation Studio: Trình đối chiếu AST đoạn văn bản song ngữ, đánh dấu thuật ngữ Glossary, kiểm tra protected inline tags (`⟦...⟧`).
  - [ ] Modal xuất bản chương: Lựa chọn 2 chiến lược `OVERWRITE_ACTIVE_VERSION` vs `CREATE_ALTERNATE_VERSION` kèm preview trực quan.
