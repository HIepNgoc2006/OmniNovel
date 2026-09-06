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
- **Trạng thái:** [/] Đang thực hiện (Phase 4A, 4B, 4C FROZEN tại commit 4cced19; Phase 4D.1-4D.4 Backend Core + #162 Manga Clean Bases 100% HOÀN TẤT & MERGED tại main@134ff86 - Chuẩn bị triển khai Phase 4D.5 Studio Frontend UI)

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

- [x] **Phase 4C: Multimodal Reader Experience (Manga 120Hz & Light Novel Customizer) (100% HOÀN TẤT & FROZEN - 36 Vitest + 14 Playwright + 139 Core API Tests - Functional Baseline SHA 4cced19e9dfdbb9ec9ec21508236ad1c2f8becff)**
  - [x] Tách biệt Layout Route Groups: `app/layout.tsx` (Root shell), `(site)/layout.tsx` (Header/Footer cho public/protected/studio), `(reader)/layout.tsx` (Clean Fullscreen Reader Shell).
  - [x] Manga Reader Engine: Chế độ cuộn dọc mượt mà (mục tiêu 120Hz), lật trang ngang Paged RTL (phải sang trái chuẩn manga Nhật) & LTR, Smart Reading HUD tự động ẩn/hiện, bàn phím điều hướng (ArrowLeft, ArrowRight, F, M), phục hồi vị trí cuộn / số trang từ `serverResume`.
  - [x] Light Novel Reader Engine: Tùy biến giao diện (Theme Sepia/Dark/Light, Font Serif/Sans, cỡ chữ 14-28px, khoảng cách dòng 1.4-2.4x, căn lề left/justify, khung đọc narrow/standard/wide), render an toàn thẻ Ruby (`<ruby><rb>...<rt>...`), Tooltip chú thích (Footnote popover), phục hồi vị trí cuộn chính xác từ `serverResume`.
  - [x] Bảo mật & An toàn nội dung: Bộ lọc HTML Sanitizer nghiêm ngặt (chỉ cho phép thẻ/thuộc tính trong allowlist, chặn toàn bộ script/iframe/event handlers và XSS); không lưu offline các tài sản thuộc truyện `PRIVATE` hoặc bản nháp `!isPublished`; tự động dọn dẹp IndexedDB offline cache khi logout.
  - [x] Đồng bộ tiến độ đọc & Gamification: Hook `useReadingProgress` đo thời gian đọc thực tế, bootstrap tiến độ (`serverResume` bao gồm `chapterVersionId` & `readingMode`) và `readChapterIds` từ server, tự động đồng bộ lên Server `PUT /api/v1/library/reading-progress` (Debounced) kèm fallback IndexedDB offline cache, tự động kích hoạt nhận thưởng +5 EXP khi đạt điều kiện (>=45s đọc & >=80% hoàn thành) theo contract `{ success: true, earnedExp: 5 }`.
  - [x] Bộ chọn phiên bản bản dịch (`VersionSelectorModal`) và Ngăn kéo mục lục nhảy chương nhanh (`ChapterDrawer`) tích hợp thanh tìm kiếm và hiển thị chính xác trạng thái "Đang đọc" / "Đã đọc".

- [/] **Phase 4D: AI Translation Studio & Apply Management**
  - [x] **Phase 4D.1 Backend Foundation (PR #167 - MERGED `main@e490136`)**:
    - [x] Studio Story/Project/Job listings contracts (#144).
    - [x] Safe sanitized job review detail & SQL aggregate counters (#148).
    - [x] Paginated review segments with composite indexes (#155 read-only portion).
  - [x] **Phase 4D.2 Backend Mutation & Freshness Core (COMPLETED — PR #168 `main@6ba9764`, PR #169 `main@d910562`, main CI Run #33742944139)**:
    - [x] Migration 0010 (Job revisions) & Migration 0011 (Segment OCC version).
    - [x] Per-Job `FOR UPDATE` mutex canonical locking protocol (#147).
    - [x] Semantic counter separation (version vs reviewRevision) & no-op PATCH semantics (#147).
    - [x] Strict protected anchor topology validation ported with parity test coverage (#147).
    - [x] Apply freshness gate & zero-leak concurrency invariant (#156 schema & Apply portion; fenced completion pending PR C #161).
    - [x] Hardening: Fail-closed GlobalExceptionFilter metadata allowlist, deterministic DB barrier & PATCH-vs-Apply race test, UUID/int/text boundary validation, SSoT API contracts (#147, #156).
  - [x] **Phase 4D.3 Contract Stabilization (COMPLETED — PR #170 `main@e8d3926`, main CI Run #84 `33763179130` SUCCESS)**:
    - [x] Novel segment blockType extension (#160) - Canonical enum: `HEADING`, `DIALOGUE`, `NARRATION`, `BLOCKQUOTE`; Migration 0012 with `novel_block_type_enum`; strict invariants at `READY_FOR_REVIEW` (enforced for Novel, forbidden for Comic).
    - [x] Typed & versioned translation manifests (#164) - Versioned schemas `MangaResultManifestV1` (version: 1, `fileSizeBytes`, `cleanBases`) & `NovelResultManifestV1` (version: 1, `segmentCount`, `charCount`, `qa`, `metrics`), pure runtime validators, discriminated union narrowing, backward-compatible `fileSize` auto-mapping, fail-closed unknown versions. Cross-service parity between TypeScript `@omninovel/shared`, Core API, and Python Worker Pydantic v2 models.
    - [x] Hardening: 5 audit findings from Run #82 resolved (Novel typed `glossarySnapshot`, callback dropped `message`, READY typed manifest union with unconditional `model_dump()`, RFC3339 timestamp parity with timezone, full regression fixtures migrated to strict V1, Core E2E 172/172 pass).
    - [ ] *Backlog (P2)*: Core prefix-jail validation độc lập cả `storageKey` lẫn `previewKey` kèm negative E2E.
  - [x] **Phase 4D.4: Materialization Protocol & Fenced Completion (COMPLETED — PR #171 MERGED `main@03f1486`, main CI Run #34023653482 SUCCESS)**:
    - [x] Dedicated materialization queue & deterministic custom job ID (#161).
    - [x] Content-addressed S3 snapshot artifact (`snapshots/{sha256}.json`) with Comic geometry and strict validators (#161).
    - [x] Fenced completion callback with idempotency-first order, stale discard, prefix-jail and exact size verification (#161, #156 remainder).
    - [x] Under-lock canonical result equality re-check, strict Novel qa.issues validation, and 22/22 dedicated E2E tests pass.
  - [x] **Manga Clean Bases Persistence Protocol (COMPLETED — PR #173 MERGED `main@134ff86`, Closed #162, main CI Run #34030875541 SUCCESS)**:
    - [x] Dedicated clean-base upload protocol on Core API (`POST /internal/v1/ai/jobs/:id/clean-base-uploads`) with fail-closed COMIC check and active processing state fence (#162).
    - [x] Attempt-scoped canonical namespace (`ai/jobs/{jobId}/review-base/attempt-{attemptNumber}/page_{page}.webp`) eliminating race conditions between stale presigned PUT URLs and authoritative retries (#162).
    - [x] Lossless WebP encoding of clean backgrounds after inpainting during QUALITY_CHECK, uploaded only after Visual QA passes (#162).
    - [x] READY_FOR_REVIEW gate enforcing 100% full-page coverage, exact attempt-scoped canonical jail, non-empty storage verification, and strict `image/webp` Content-Type verification (#162).
    - [x] Post-commit cleanup outside DB transaction on `applyJob`, preserving clean bases in materialization candidates (#162, #171).
    - [x] Retry stale-PUT isolation regression test and follow-up sweeper split to #172 (#162, #172).
  - [ ] **Phase 4D.5 Studio Frontend UI**:
    - [ ] Studio Dashboard: Danh sách Translation Projects, Bảng theo dõi tiến độ Job thời gian thực qua WebSocket `/ws/ai` (14 stages).
    - [ ] Manga Translation Studio: Trình xem ảnh gốc vs ảnh đã dịch, xem vùng nhận diện thoại OCR, chỉnh sửa bản dịch từng ô thoại.
    - [ ] Novel Translation Studio: Trình đối chiếu AST đoạn văn bản song ngữ, đánh dấu thuật ngữ Glossary, kiểm tra protected inline tags (`⟦...⟧`).
    - [ ] Modal xuất bản chương: Lựa chọn 2 chiến lược `OVERWRITE_ACTIVE_VERSION` vs `CREATE_ALTERNATE_VERSION` kèm preview trực quan.
