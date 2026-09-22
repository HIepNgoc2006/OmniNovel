# 📱 Phase 5: Ứng Dụng Di Động (Mobile App - Flutter Android-First)

- **Mục tiêu:** Phát triển Ứng dụng Di động OmniNovel Client chuyên dụng cho Trải nghiệm Đọc (Reader-First UX) bằng Flutter trên nền tảng Android, hỗ trợ tần số quét cao (90Hz / 120Hz / 144Hz), kiểm soát bộ nhớ RAM nghiêm ngặt chống OOM, tích hợp hệ thống Gamification và đọc Offline.
- **Trạng thái:** `[/] Đang Khởi Động (Arch Baseline & Scaffolding Preparation)`
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
│   │   ├── storage/          # Local Storage (SharedPreferences & Encrypted SQLite)
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
│   │   └── offline/          # MOB-012: Quản lý tải và giải mã chương truyện offline
└── test/                     # Unit, Widget & Golden Tests
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

### 📖 Phase 5B: Reader Vertical Slice (E2E Core Flow) - [x] HOÀN THÀNH
- [x] Xây dựng luồng đọc xuyên suốt hoàn chỉnh:
  $$\text{Login} \longrightarrow \text{Home} \longrightarrow \text{Story Detail} \longrightarrow \text{Chapter} \longrightarrow \text{Webtoon Reader 120/144Hz} \longrightarrow \text{Auto Save Progress} \longrightarrow \text{Kill App} \longrightarrow \text{Resume}$$
- [x] Triển khai `WebtoonReader`: Sử dụng Virtualized List với cơ chế 3-Zone Memory (`ReaderWindowPolicy`, `ReaderSessionController`, `ReaderImageCacheCoordinator`) kiểm soát `ImageCache.evict()` targeted eviction để duy trì working-set RAM < 150MB.
- [x] Tích hợp API đồng bộ tiến độ: Contract parity backend/DB (`pageIndex`, `anchorBlockId`, `textOffset`), Local Checkpoint tức thì (SharedPreferences) chống mất tiến độ khi Kill-App, Debounce 1.5s đẩy server, và Reconciliation đối chiếu `updatedAt`.
- [x] Tích hợp Presigned Media URL qua `MediaRepository` có in-memory TTL caching chống anti-leech rate limit (60 req/phút).
- [x] Kiểm thử toàn diện: 64/64 tests Mobile Suite GREEN (100%), `flutter analyze` 0 issues found, biên dịch Debug APK thành công trên Android API 24–36.

### 🎨 Phase 5C: Đa Định Dạng Trình Đọc & Tính Năng Hoàn Chỉnh (MOB-001..MOB-011)
- [ ] **Manga Paged Reader (MOB-005):** Hỗ trợ lật trang phải sang trái (RTL), phóng to/thu nhỏ cảm ứng (InteractiveViewer/Pinch-zoom).
- [ ] **Novel Reader (MOB-006):** Trình đọc truyện chữ với giao diện Typography tùy biến (cỡ chữ, khoảng cách dòng, màu nền Sepia/OLED) và định vị đoạn văn bằng `anchorBlockId`.
- [ ] **Khám phá & Tìm kiếm (MOB-001, MOB-002, MOB-003):** Kết nối API `GET /api/v1/stories?search=...`, danh mục thể loại và trang thông tin truyện.
- [ ] **Tủ sách & Gamification (MOB-009, MOB-010):** Đánh dấu Bookmark, điểm danh hàng ngày nhận Coin/EXP, hiển thị cấp độ và danh hiệu Rank Theme.
- [ ] **Báo lỗi chương (MOB-011):** Bottom Sheet gửi báo cáo lỗi đến backend qua endpoint `POST /api/v1/chapters/:id/reports` (Issue #191).

### 💾 Phase 5D: Lưu Trữ Offline & Hoàn Thiện Nghiệm Thu (MOB-012 & Polish)
- [ ] **Offline Storage (MOB-012):** Tải gói chương truyện (ZIP manifest) và giải mã cục bộ bằng SQLite mã hóa (SQLCipher/sqflite).
- [ ] Tích hợp tính năng backend đóng gói ngược chương truyện cũ (Issue #190: Canonical Reverse Packaging).
- [ ] **Popup Action Sheet Studio:** Hỗ trợ thông báo xác nhận duyệt bản dịch AI nhanh cho Editor/Owner khi AI dịch xong.
- [ ] Chạy ma trận kiểm thử tương thích Android (Android 7 ➔ Android 16) và đo đạc Frame Budget.

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
