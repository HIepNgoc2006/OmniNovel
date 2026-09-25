# 📱 Phase 5: Ứng Dụng Di Động (Mobile App - Flutter Android-First)

- **Mục tiêu:** Phát triển Ứng dụng Di động OmniNovel Client chuyên dụng cho Trải nghiệm Đọc (Reader-First UX) bằng Flutter trên nền tảng Android, hỗ trợ tần số quét cao (90Hz / 120Hz / 144Hz), kiểm soát bộ nhớ RAM nghiêm ngặt chống OOM, tích hợp hệ thống Gamification và đọc Offline.
- **Trạng thái:** `[/] Phase 5 đang triển khai — 5A, 5B & 5C hoàn thành (Frozen Baseline ✅), 5D kế tiếp (Lưu Trữ Offline MOB-012 & Hoàn Thiện)`
- **Môn học phụ trách:** Môn 2 — *Phát triển Ứng dụng Di động (Mobile Development)* (kết hợp Môn 1 & Môn 4).

---

## 1. Các Quyết Định Kiến Trúc Cốt Lõi (Architecture Decisions)

1. **Lựa chọn Nền tảng: Flutter (Dart) — Android-First**
   - Không chọn React/WebView bọc ngoài do workload reader cuộn ảnh dài cực kỳ nặng, đòi hỏi kiểm soát trực tiếp quá trình giải mã ảnh (bitmap decoding), vùng đệm viewport và vòng đời giải phóng bộ nhớ (memory eviction) để chống tràn RAM (OOM).
   - Tiếp tục duy trì song song Web Client (Next.js) cho máy tính và Studio dịch thuật; Backend NestJS là Single Source of Truth (SSoT) duy nhất phục vụ cả Web và Mobile.
2. **Android Compatibility Baseline:**
   - `minSdk`: **24** (Android 7.0 Nougat) — Đảm bảo phục vụ đa dạng các dòng máy Android cũ.
   - `targetSdk`: **36** (Android 16) — Tuân thủ chuẩn bắt buộc của Google Play Console từ ngày 31/08/2026.
   - `compileSdk`: **>= 36**.
   - Hỗ trợ kiến trúc: **ARM64-v8a**, **ARMeabi-v7a**. Định dạng phân phối: **Android App Bundle (AAB)**.
3. **Đặc tả Frame Budget theo Tần số quét thực tế:**
   - 60Hz: Frame time $< 16.67\text{ ms}$
   - 90Hz: Frame time $< 11.11\text{ ms}$
   - 120Hz: Frame time $< 8.33\text{ ms}$
   - 144Hz: Frame time $< 6.94\text{ ms}$
4. **Cơ chế Quản lý Bộ nhớ Reader (Image Scheduling & Eviction):**
   - Tránh tuyệt đối giải mã đồng thời 30–100 ảnh full-resolution cùng lúc (1 ảnh $1440 \times 2500\text{ RGBA} \approx 14.4\text{ MB}$, 10 ảnh $> 140\text{ MB}$).
   - Thiết lập cửa sổ hiển thị (Windowing Buffer):
     - `viewport`: Decode và render ảnh đang xem.
     - `adjacent (±1-2)`: Prefetch và decode trước ảnh kế tiếp / ảnh trước.
     - `distant pages`: Lập tức evict/dispose bitmap buffer khỏi RAM để duy trì RAM tiêu thụ $< 150\text{ MB}$.

---

## 2. Cấu Trúc Mã Nguồn Module (`apps/mobile/`)

```
apps/mobile/
├── android/                  # Android Native project (minSdk 24, targetSdk 36)
├── lib/
│   ├── app/                  # Application Bootstrap, Theme & Router
│   │   ├── bootstrap/
│   │   ├── router/           # GoRouter / Navigator 2.0
│   │   └── theme/            # OmniNovel Dark/Light Theme & OLED Pure Black
│   ├── core/                 # Shared Infrastructure & Services
│   │   ├── api/              # Dio Client, JWT Interceptors & Error Mapper
│   │   ├── auth/             # Token Storage (FlutterSecureStorage) & Auth State
│   │   ├── cache/            # Local Image & Metadata Cache Manager
│   │   ├── storage/          # Local Storage (SharedPreferences, SQLite metadata & App-Private Storage)
│   │   └── errors/           # Standard JSON Error Handling Matching Backend
│   ├── features/             # Feature Modules (Reader-First)
│   │   ├── auth/             # MOB-008: Đăng nhập, Đăng ký & Tài khoản
│   │   ├── home/             # MOB-001: Feed truyện HOT, Mới nhất, Bảng xếp hạng
│   │   ├── search/           # MOB-002: Tìm kiếm & Gợi ý (GET /api/v1/stories?search=...)
│   │   ├── story/            # MOB-003: Chi tiết truyện, Danh sách tập & chương
│   │   ├── library/          # MOB-009: Tủ sách cá nhân & Bookmark
│   │   ├── reader/           # TRỌNG TÂM: Reader Engine độc lập
│   │   │   ├── webtoon/      # MOB-004: Trình đọc cuộn dọc 120Hz chống OOM
│   │   │   ├── manga/        # MOB-005: Trình đọc lật trang (Paged / RTL / Pinch-zoom)
│   │   │   ├── novel/        # MOB-006: Trình đọc Novel (Typography, Anchor Blocks)
│   │   │   ├── gallery/      # MOB-007: Bộ sưu tập ảnh minh họa
│   │   │   └── progress/     # Đồng bộ tiến độ đọc (PUT & GET /library/reading-progress)
│   │   ├── gamification/     # MOB-010: Điểm danh, EXP, OmniCoin & Rank Themes
│   │   ├── report/           # MOB-011: Bottom Sheet báo lỗi chương (Gọi Issue #191)
│   │   └── offline/          # MOB-012: Quản lý tải và lưu trữ chương truyện offline
│   └── test/                 # Unit, Widget & Golden Tests
```

---

## 3. Lộ Trình Triển Khai Phân Rã (WBS & Sub-phases)

### 🚀 Phase 5A: Khung Ứng Dụng & Hạ Tầng Core (Foundation) - [x] HOÀN THÀNH
- [x] Khởi tạo dự án Flutter trong `apps/mobile` (cấu hình Android `minSdk 24`, `targetSdk 36`, `compileSdk 36`, Java 17).
- [x] Xây dựng `core/api`: Dio client cấu hình baseURL, Timeout, Logging và `AuthInterceptor` tự động làm mới JWT token (`/api/v1/auth/refresh`) với Single-Flight Mutex concurrency guard.
- [x] Chuẩn hóa Error Handling: Ánh xạ mã lỗi HTTP chuẩn JSON từ Core API (`code`, `message`, `requestId`, `details`, `meta`).
- [x] Thiết lập Local Secure Storage lưu trữ Access Token và Refresh Token an toàn bằng `FlutterSecureStorage` (Android `EncryptedSharedPreferences`), tách biệt `PreferencesService` (SharedPreferences) cho cấu hình giao diện.
- [x] Xây dựng App Shell, `GoRouter` với Auth Guard Redirect và Theme System (OmniNovel Dark Mode & OLED Pure Black `#000000`).
- [x] Bộ kiểm thử Foundation: 18/18 tests GREEN, `flutter analyze` 0 error/warning (đáp ứng 100% Gate 5A).

### 📖 Phase 5B: Reader Vertical Slice (E2E Core Flow) - [x] HOÀN THÀNH (PERFORMANCE-FROZEN BASELINE ✅)
- [x] Xây dựng luồng đọc xuyên suốt hoàn chỉnh:
  $$\text{Login} \longrightarrow \text{Home} \longrightarrow \text{Story Detail} \longrightarrow \text{Chapter} \longrightarrow \text{Webtoon Reader 120/144Hz} \longrightarrow \text{Auto Save Progress} \longrightarrow \text{Kill App} \longrightarrow \text{Resume}$$
- [x] Triển khai `WebtoonReader`: Sử dụng Virtualized List với cơ chế 3-Zone Memory (`ReaderWindowPolicy`, `ReaderSessionController`, `ReaderImageCacheCoordinator`) kiểm soát `ImageCache.evict()` targeted eviction để duy trì working-set RAM < 150MB.
- [x] **P0 — Webtoon Visible-Page Tracking theo Hình học Thực tế:** Thuật toán `WebtoonGeometryCalculator` với binary search $O(\log N)$ và `argmax(visibleHeight)` xác định chính xác trang tiêu điểm bất kể các trang có kích thước khác nhau ($800 \times 1200$ đến $800 \times 3200$).
- [x] **P1 — Decode-Size Bounding & Memory Budget Prefetch:** Giới hạn giải mã qua `ResizeImage` theo `viewportWidth * dpr`, kiểm soát ngân sách bộ nhớ bitmap adjacent pages ($\le 80\text{ MB}$) chống OOM triệt để.
- [x] **P1 — Signed URL Rotation & One-Shot 403 Recovery:** Quản lý Provider Key `(assetId, targetWidth, url)`, tự động evict khi URL đổi và tự phục hồi 1 lần khi URL hết hạn (403).
- [x] **P1 — Đóng băng Toolchain Bất biến:** Ghim Flutter 3.44.0 (Dart 3.12.0) qua Docker digest `sha256:217a3d8...` và CI `flutter-version: '3.44.0'`.
- [x] Tích hợp API đồng bộ tiến độ: Contract parity backend/DB (`pageIndex`, `anchorBlockId`, `textOffset`), Local Checkpoint tức thì (SharedPreferences) chống mất tiến độ khi Kill-App, Debounce 1.5s đẩy server, và Reconciliation đối chiếu `updatedAt`.
- [x] Tích hợp Presigned Media URL qua `MediaRepository` có in-memory TTL caching chống anti-leech rate limit (60 req/phút).
- [x] Bộ kiểm thử & Bằng chứng giả lập chuẩn hóa: 78/78 tests Mobile Suite GREEN (100%), `flutter analyze` 0 issues, stress fixture 150 trang mixed dimensions, peak RSS 91.5MB (<150MB), 120Hz P90 6.85ms, jank 0.8%, process-death resume chính xác 100% trên Pixel 7 / Android SDK Emulator API 34 ([Báo cáo chi tiết](file:///e:/Workspace%202/Doctruyen_project/plans/evidence/phase_5b_hardware_evidence.md)).

### 🎨 Phase 5C: Đa Định Dạng Trình Đọc & Tính Năng Hoàn Chỉnh (MOB-001..MOB-011) - [x] HOÀN THÀNH (FROZEN BASELINE ✅)
- [x] **[Phase 5C.1] Manga Paged Reader ([Issue #197](https://github.com/HIepNgoc2006/OmniNovel/issues/197)):** Hỗ trợ lật trang phải sang trái (RTL/LTR), phóng to/thu nhỏ cảm ứng (InteractiveViewer/Pinch-zoom), tái sử dụng hạ tầng ImageCache 80MB & progress sync.
- [x] **[Phase 5C.2] Novel Reader ([Issue #198](https://github.com/HIepNgoc2006/OmniNovel/issues/198)):** Trình đọc truyện chữ với giao diện Typography tùy biến (cỡ chữ, giãn dòng, theme Sepia/OLED) và định vị đoạn văn bằng `anchorBlockId`.
- [x] **[Phase 5C.3] Khám phá & Tìm kiếm ([Issue #199](https://github.com/HIepNgoc2006/OmniNovel/issues/199)):** Home Feed Hero Carousel, Bảng xếp hạng Top Comics/Novels, Truyện mới cập nhật, Tìm kiếm đa bộ lọc (Debounce 500ms, Filter Chips genres tải động từ API `GET /api/v1/genres`, infinite scroll, recent searches SharedPreferences, query generation guard chống race condition), Chi tiết truyện (Story Detail production UI với blurred backdrop, volume grouping canonical, numeric chapter sorting `double.tryParse`, read checkmarks, resume reading pointer). SSoT `StoryRepository` khóa tại `AppRouter`. Baseline 121/121 tests GREEN, `flutter analyze` 0 issues.
- [x] **[Phase 5C.4] Tủ sách Cá nhân ([Issue #200](https://github.com/HIepNgoc2006/OmniNovel/issues/200)):** Quản lý Bookmark, Lịch sử đọc truyện (History) và Thẻ đọc tiếp nhanh (Continue Reading). Khóa chặt chuỗi PostgreSQL row serialization, monotonic per-user epoch, zero-fallback hydration, và 17/17 verification gates.
- [x] **[Phase 5C.5] Gamification & Hồ sơ ([Issue #201](https://github.com/HIepNgoc2006/OmniNovel/issues/201)):** Hệ thống MangaPass, Chuỗi điểm danh Daily Streak (monotonic countdown, UTC+7 VN clock SSoT, midnight rollover auto-refresh), 6 Canonical Rank Themes (User-scoped preferences, optimistic rollback, server-reconcile, dynamic theme tokens `context.primaryColor` & `context.primaryLightColor` phủ kín toàn bộ acceptance surfaces), Sổ cái OmniCoin ledger với PostgreSQL pessimistic locking + Canonical Redis lock compare-and-delete atomic Lua script (TTL safety net 120s), Tự động thưởng EXP Đọc Truyện (Active reading stopwatch >=45s, tiến độ >=80%, required `serverDateVN` trên 4 nhánh HTTP-200, production lifecycle fail-closed server rollover, loại bỏ hoàn toàn mọi fallback về local clock, Gate 9D clock-skew zero-request guard), Uncertain-outcome positive reconciliation (xác nhận DB commit thành công khi timeout/in-flight, không rethrow). Bộ kiểm thử: 26/26 Backend Suites PASS (334/334 tests, gồm structured exception filter & gamification), 161/161 Mobile tests PASS (100% GREEN), `flutter analyze` 0 issues. FROZEN BASELINE.
- [x] **[Phase 5C.6] Báo lỗi chương ([Issue #202](https://github.com/HIepNgoc2006/OmniNovel/issues/202)):** Triển khai Backend API #191 (`POST /api/v1/chapters/:id/reports`) và Mobile MOB-011 Bottom Sheet. Kiểm soát quyền truy cập độc giả & unpublished versions, ràng buộc chặt chẽ rendered version ID (`activeVersion.id`), phân lập rate limit per-chapter qua `routeParam: 'id'` (`3 req/60s`) kèm metadata `retryAfter`, chống trùng lặp bằng transaction `pessimistic_write` lock và NULL-safe SQL location equality. Phía Mobile hỗ trợ lifted anchor từ `NovelReaderView`, Top HUD flag action, Bottom Sheet UI chuẩn hóa 7 categories, checkbox báo lỗi toàn chương, đếm ngược cooldown timer và Gate 7 guest auth dialog (zero API calls). Đạt 100% 7 Verification Gates. Backend: 28/28 suites PASS (352/352 tests). Mobile: 100% tests PASS, `flutter analyze` 0 issues.

### 💾 Phase 5D: Lưu Trữ Offline & Hoàn Thiện Nghiệm Thu (MOB-012 & Polish)
- [x] **Backend Prerequisite ([Issue #190](https://github.com/HIepNgoc2006/OmniNovel/issues/190)):** Triển khai *Canonical Reverse Packaging Service* qua BullMQ bền vững (`chapter-packaging`, deterministic `jobId`), lưu trữ MinIO S3 qua `StorageService`, bảng `chapter_artifacts`, ràng buộc loại trừ nguồn (`chk_translation_jobs_canonical_source`), endpoints `GET .../artifact` và `POST .../package`. *(CLOSED ✅ - Commit 1c82012)*
- [x] **Phase 5D.3 — Durable Offline Download Manager & App-Private Storage (MOB-012 / Issue #203):**
  - Quản lý hàng đợi tải chương với SQLite metadata (`sqflite`), ràng buộc `UNIQUE(chapter_version_id)` chống duplicate tasks.
  - Tách biệt `ArtifactDownloadClient`/Dio độc lập, không gắn `AuthInterceptor`, không rò rỉ JWT token sang MinIO/S3 storage host.
  - Fail-closed presigned URL refresh & HTTP Range resume từ Filesystem SSoT (`resumeOffset = partFile.length()`; `206 Partial Content` append khi start khớp offset vs `200 OK` truncate restart byte 0; 403 storage không trigger auth refresh).
  - Tải stream tệp `.part` vào App-Private sandbox (`context.filesDir/offline/tmp/`, phân quyền OS `0700` + Android FBE).
  - State machine bền vững: 5D.3 chỉ sở hữu `QUEUED -> DOWNLOADING -> VERIFYING` (chống phát sinh `READY` giả), Crash recovery (`DOWNLOADING/VERIFYING -> PAUSED`).
  - Toàn bộ 18/18 Verification Acceptance Gates PASS 100% (gồm fail-closed Range parse/mismatch, worker settle concurrency mutex, 403 immutable metadata verification), 189/189 Mobile tests PASS, `flutter analyze` 0 issues. *(FROZEN-FINAL ✅)*
- [x] **Phase 5D.4 — Offline Bundle Installation & Bidirectional Integrity Verification (MOB-012 / [Issue #204](https://github.com/HIepNgoc2006/OmniNovel/issues/204)):**
  - **Ownership tuyệt đối:** Duy nhất 5D.4 `BundleInstaller` sở hữu bước chuyển trạng thái `VERIFYING ➔ READY | FAILED`. Tuyệt đối không repo/UI/recovery nào tự suy diễn READY từ `.part` hay `installed/`.
  - **Checksum-before-unzip:** Đối chiếu SHA-256 từ tệp `.part` trực tiếp với `sha256Hash` đã pin trên `download_tasks` (không fetch hash mới từ server khi install).
  - **Archive extraction fail-closed:** Chặn Zip Slip (`../`, absolute path, entry thoát staging root), từ chối symlink/hardlink, duplicate paths, archive malformed, và giới hạn trần giải nén (max 1000 files, max 500MB uncompressed) chống Zip Bomb.
  - **Manifest identity binding:** Bind chính xác `chapterVersionId == task.chapterVersionId`, `chapterId`, `storyId`, `mediaFormat`; validate toàn bộ file inventory trên đĩa.
  - **Cross-domain Crash Protocol:** Thiết kế giao thức phục hồi lỗi crash giữa rename filesystem và SQLite commit.
  - **Canonical READY SSoT:** Chỉ đọc offline khi có đồng thời `offline_chapters` row (không có cột `status`, row existence là proof) và payload `installed/` hợp lệ.
  - **Deterministic Bidirectional Reconciliation:** Row có nhưng file mất ➔ xóa row; folder có nhưng DB row thiếu ➔ verify & reconstruct nếu hợp lệ và có task, hoặc xóa orphan nếu hỏng/vô chủ; dọn sạch staging orphan và `.part` còn sót.
  - **Idempotency & Clean Isolation:** Cài đặt lại an toàn không duplicate/corrupt; background isolate `compute` không drop frame UI; toàn bộ 16/16 Verification Acceptance Gates PASS 100%, 203/203 Mobile tests PASS, `flutter analyze` 0 issues. *(FROZEN BASELINE ✅)*
- [ ] **Phase 5D.5 — Reader Offline Resolution:**
  - Tích hợp Webtoon, Manga và Novel Reader nạp trực tiếp file trong sandbox `0700` (`FileImage`), 0 request mạng khi ngắt Internet (Airplane Mode), offline checkpoint progress.
- [ ] **Phase 5D.6 — Quản Lý Dung Lượng & LRU Eviction:**
  - Storage Quota, LRU Eviction tự động và Manual Delete chương/truyện đã tải.
- [ ] **Phase 5D.7 — Studio Quick-Approval Action Sheet (Polish - Non-blocking):**
  - Popup Action Sheet duyệt nhanh bản dịch AI cho Editor/Owner (tách riêng, không thuộc scope MOB-012).
- [ ] **Phase 5D.8 — Nghiệm Thu Thiết Bị Vật Lý & Hoàn Tất Phase 5:**
  - Kiểm thử đo đạc thực địa trên thiết bị Android vật lý (Low-End 2–3GB RAM & Mid-Range 4–6GB RAM) xác nhận working-set RSS < 150MB và Frame Budget 120Hz/90Hz/60Hz.

---

## 4. Ma Trận Kiểm Thử Tương Thích Thiết Bị (Device & Hardware Matrix)

| Phân Khúc Thiết Bị | Thông Số Phần Cứng | Mục Tiêu Tần Số Quét | Trọng Tâm Kiểm Thử |
| :--- | :--- | :---: | :--- |
| **Low-End** | 2–3 GB RAM, Màn hình 720p, Android 7–9 | 60 Hz ($< 16.67\text{ ms}$) | Chống tràn bộ nhớ OOM, giải phóng bitmap tức thì |
| **Mid-Range** | 4–6 GB RAM, Màn hình 1080p, Android 10–13 | 90 / 120 Hz ($< 11.11 / 8.33\text{ ms}$) | Cuộn mượt, prefetch hình ảnh không drop frame |
| **High-End / Flagship**| 8+ GB RAM, Màn hình 1440p, Android 14–16 | 120 / 144 Hz ($< 8.33 / 6.94\text{ ms}$) | Tận dụng GPU rendering tối đa, chuyển cảnh tức thì |

---

## 5. Danh Sách Tracking Issues Liên Quan Trên GitHub
- **[Issue #140](https://github.com/HIepNgoc2006/OmniNovel/issues/140):** Dependency security triage & remediation (Đã triage an toàn & vá `adm-zip`).
- **[Issue #190](https://github.com/HIepNgoc2006/OmniNovel/issues/190):** `[Phase 5][Backend] Canonical Reverse Packaging for MediaAsset-backed ChapterVersions` (Phục vụ tải offline).
- **[Issue #191](https://github.com/HIepNgoc2006/OmniNovel/issues/191):** `[Phase 5][Backend] Implement Chapter Error Reporting API (POST /api/v1/chapters/:id/reports)` (Phục vụ MOB-011).
- **[Issue #192](https://github.com/HIepNgoc2006/OmniNovel/issues/192):** `[Phase 5 Master Tracker] Flutter Mobile App Implementation (MOB-001 -> MOB-012)` (Master Living Tracker).
- **[Issue #197](https://github.com/HIepNgoc2006/OmniNovel/issues/197):** `[Phase 5C.1][Mobile] Manga Paged Reader Engine (RTL/LTR, Pinch-to-Zoom, Memory-Bounded PageView)`.
- **[Issue #198](https://github.com/HIepNgoc2006/OmniNovel/issues/198):** `[Phase 5C.2][Mobile] Novel Reader Engine (AnchorBlockId Positioning, Typography Customization & Sepia/OLED Themes)`.
- **[Issue #199](https://github.com/HIepNgoc2006/OmniNovel/issues/199):** `[Phase 5C.3][Mobile] Discovery Surfaces (Home Feed, Multi-Filter Search & Production Story Detail UI)`.
- **[Issue #200](https://github.com/HIepNgoc2006/OmniNovel/issues/200):** `[Phase 5C.4][Mobile] User Library (Bookmarks, Reading History & Continue Reading Resumption)`.
- **[Issue #201](https://github.com/HIepNgoc2006/OmniNovel/issues/201):** `[Phase 5C.5][Mobile] Gamification & Profile (MangaPass Progression, Daily Check-in & Rank Themes)`.
- **[Issue #202](https://github.com/HIepNgoc2006/OmniNovel/issues/202):** `[Phase 5C.6][Mobile & API] Chapter Content Reporting System (Backend API #191 & Mobile MOB-011 Bottom Sheet)`.
- **[Issue #203](https://github.com/HIepNgoc2006/OmniNovel/issues/203):** `[Phase 5D.3][Mobile] Durable Offline Download Manager & App-Private Storage`.
- **[Issue #204](https://github.com/HIepNgoc2006/OmniNovel/issues/204):** `[Phase 5D.4][Mobile] Offline Bundle Installation & Bidirectional Integrity Verification`.
