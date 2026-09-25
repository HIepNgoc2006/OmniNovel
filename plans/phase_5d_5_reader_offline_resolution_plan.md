# Kế hoạch Triển khai Phase 5D.5: Reader Offline Resolution (MOB-012 / Issue #205)

> **Dành cho Agentic Workers:** Yêu cầu áp dụng quy chuẩn TDD, Clean Architecture, KISS & YAGNI, bảo toàn SSoT của Phase 5D.4 và Phase 5C. Tuân thủ nghiêm ngặt 4 Amendment P0 và các siết chặt P1.

**Mục tiêu:** Tích hợp bộ giải quyết nội dung ngoại tuyến thống nhất (`OfflineContentResolver`) vào 3 bộ máy đọc (Webtoon, Manga Paged, và Light Novel), đảm bảo khi chương đã được cài đặt hợp lệ trên máy, toàn bộ trải nghiệm đọc diễn ra với **0 network request** (kể cả presigned URL lookups, chapter API, progress epoch, novel content, gamification), bảo đảm exact-version identity, fail-closed khi payload bị hỏng, và lưu trữ / replay bền vững tiến độ đọc ngoại tuyến khi kết nối mạng trở lại.

---

## 1. Bốn Amendment P0 và Siết Chặt P1 Đã Khóa

1. **P0.1 — Exact-Version Selection Policy:**
   - Tuyệt đối không query `WHERE chapter_id = ? LIMIT 1`.
   - `offline_chapters` được định danh canonical bằng `chapterVersionId`.
   - `OfflineContentResolver.resolveChapter({required String chapterId, String? preferredVersionId})`:
     - Nếu có `preferredVersionId`: exact-match `getOfflineChapter(preferredVersionId)` và kiểm tra `candidate.chapterId == chapterId`.
     - Nếu `preferredVersionId == null`: truy vấn toàn bộ phiên bản đã cài qua `getOfflineChaptersByChapterId(chapterId)` và sắp xếp deterministic theo `installedAt DESC, chapterVersionId DESC`.
   - Bổ sung `versionId` vào `ReaderScreen` để các bề mặt (như Offline Library) truyền đích danh phiên bản mong muốn.

2. **P0.2 — Global Zero-Network & Tách Biệt Chế Độ (`ReaderTransportMode`):**
   - Phân định rõ chế độ: `ReaderTransportMode.offline` vs `ReaderTransportMode.online`.
   - Quá trình phân giải offline (`OfflineContentResolver`) xảy ra **TRƯỚC MỌI NETWORK SIDE EFFECT**.
   - Nếu offline resolution thành công:
     - Không gọi `ChapterRepository.getChapterDetail()` (0 HTTP).
     - Không gọi `_progressCoordinator.startSession(storyId)` để hydrate server epoch (0 HTTP).
     - Không gọi `MediaRepository.getMediaDownloadUrl()` (0 HTTP).
     - Không gọi `NovelContentRepository.loadNovelHtml()` qua Dio (0 HTTP).
     - Không gọi Gamification progression/reward API (0 HTTP).
     - Cấp phát hình ảnh cục bộ qua `FileImage` / `Image.file`.

3. **P0.3 — Reconnect Replay Protocol & Bền Vững Tiến Độ Đọc (Phase 5C Alignment):**
   - Khi đọc offline: `recordProgress()` ghi nhận tức thì vào `LocalReadingCheckpoint` (SharedPreferences) với 0 request mạng.
   - Khi app bị kill giữa chừng trong lúc offline: dữ liệu checkpoint vẫn tồn tại bền vững trên đĩa.
   - Khi mạng kết nối trở lại: `startSession(storyId)` hydrate canonical `serverEpoch` từ server (Zero-fallback), kiểm tra local checkpoint chưa sync, materialize pending draft với `serverEpoch` mới và đẩy lên server đúng 1 lần.
   - Bảo toàn anti-resurrection của Phase 5C: không bao giờ dùng local clock làm epoch fallback.

4. **P0.4 — Synthetic `ChapterDetail` Ràng Buộc Exact `chapterVersionId`:**
   - `OfflineContentResolver` tổng hợp `ChapterDetail` canonical từ `manifest.json`.
   - `ChapterDetail.activeVersion.id` bắt buộc phải là `offlineChapter.chapterVersionId`.
   - `storyId`, `chapterId`, `mediaFormat`, `versionNumber`, `language` được trích xuất từ manifest đã verify, không đoán mò từ route params.
   - `ReaderScreen._onProgressChanged()` ghi nhận đúng `chapterVersionId` canonical.

5. **P1.1 — Type-Safe Image Source:**
   - `ReaderImageCacheCoordinator` nhận diện rõ nguồn tệp cục bộ (`_localAssetFiles`), không ép đường dẫn tệp đĩa thành URL giả mạo. Cơ chế 403 recovery chỉ kích hoạt cho `NetworkImage`.
6. **P1.2 — Strict Whitelist Cho Ảnh Minh Họa Novel:**
   - Trong `content.html`, chỉ resolve các ảnh minh họa có khai báo trong `manifest.files`. Mọi URL ngoại lai (external/tracking URL) ở chế độ offline bị chặn tải qua mạng và hiển thị placeholder an toàn.

---

## 2. Bản Đồ Tập Tin (File Map)

### Tạo mới:
1. `apps/mobile/lib/features/offline/services/offline_content_resolver.dart`
   - Chứa `OfflineContentResolver` và model `ResolvedOfflineChapter`.
2. `apps/mobile/test/features/reader/reader_offline_resolution_acceptance_test.dart`
   - Bộ 8 Verification Acceptance Gates cho Phase 5D.5.

### Chỉnh sửa:
3. `apps/mobile/lib/features/offline/repositories/offline_storage_repository.dart`
   - Bổ sung `getOfflineChaptersByChapterId(String chapterId)` trả về `List<OfflineChapter>`.
4. `apps/mobile/lib/features/reader/presentation/reader_image_cache_coordinator.dart`
   - Hỗ trợ đăng ký `_localAssetFiles`, trả về đường dẫn tệp cục bộ trong `getPageUrl` không cần mạng, và cấp phát `FileImage` trong `getImageProvider`.
5. `apps/mobile/lib/features/reader/presentation/reader_session_state.dart`
   - Bổ sung `enum ReaderTransportMode { online, offline }`, cờ `transportMode`, và `resolvedOfflineChapter`.
6. `apps/mobile/lib/features/reader/presentation/reader_session_controller.dart`
   - Nhận `OfflineContentResolver?`. Trong `loadChapter`: gọi resolver trước; nếu thành công chuyển sang `ReaderTransportMode.offline`, nếu thất bại fallback sang online `_chapterRepository`.
7. `apps/mobile/lib/features/reader/presentation/reading_progress_coordinator.dart`
   - Bổ sung Reconnect Replay Protocol: hydrate server epoch -> đọc un-synced local checkpoint -> materialize & sync.
8. `apps/mobile/lib/features/reader/presentation/novel_reader_view.dart`
   - Hỗ trợ `_NovelBlockWidget` render ảnh minh họa cục bộ qua `Image.file`, chặn network call đối với URL ngoài ở chế độ offline.
9. `apps/mobile/lib/features/reader/presentation/reader_screen.dart`
   - Nhận `versionId?` và `OfflineContentResolver?`. Chỉ kích hoạt server progress sync và gamification khi ở `ReaderTransportMode.online`. Nạp `novelHtmlContent` trực tiếp từ resolver khi offline.
10. `plans/phase_5d_offline_implementation_plan.md` & `plans/phases/phase_05_mobile_app.md`
   - Cập nhật tiến độ Phase 5D.5.

---

## 3. Ma Trận 8 Tiêu Chuẩn Nghiệm Thu (8 Acceptance Gates)

| Gate | Tiêu Chí Kiểm Tra (Acceptance Criteria) |
| :--- | :--- |
| **Gate 1: Exact-Version Selection** | Khi có `preferredVersionId`, exact-match version đó; khi `preferredVersionId == null`, chọn theo policy deterministic (`installedAt DESC, versionNumber DESC`). Không chọn ngẫu nhiên / stale version. |
| **Gate 2: Global Zero-Network (Webtoon & Manga)** | Toàn bộ các service (Chapter API, Media presigned URL, Progress epoch hydration, Gamification) thực hiện chính xác **0 network request**. Page order đúng theo manifest. |
| **Gate 3: Novel Strict Whitelist & Local Illustration** | Nạp `content.html` offline, ảnh minh họa whitelisted render qua `Image.file`, ảnh ngoại lai không rõ nguồn gốc không gửi request mạng. 0 HTTP calls. |
| **Gate 4: Version-Bound Progress** | `ChapterDetail.activeVersion.id` khớp chính xác `chapterVersionId` đã cài; reading progress ghi nhận đúng `chapterVersionId`. |
| **Gate 5: SSoT Proof Gate** | Task có status `READY` nhưng bảng `offline_chapters` thiếu row $\rightarrow$ resolver từ chối trả dữ liệu (`null`). |
| **Gate 6: Runtime Corruption Fail-Closed** | Tệp bị xóa/tamper trên đĩa $\rightarrow$ fail-closed sang online nếu có mạng, hoặc báo lỗi sạch sẽ nếu Airplane Mode. Tuyệt đối không render dở dang. |
| **Gate 7: Offline $\rightarrow$ Reconnect Durable Progress Replay** | Đọc offline $\rightarrow$ kill app $\rightarrow$ mở lại khi online $\rightarrow$ hydrate server epoch canonical $\rightarrow$ replay local checkpoint đúng 1 lần với epoch mới. |
| **Gate 8: App Restart Offline Resumption** | Khởi động lại ứng dụng, mở chương đã tải ngoại tuyến hoạt động tức thì với 0 network latency. |

---

## 4. Các Nhiệm Vụ Triển Khai (Bite-Sized Tasks)

### Task 1: Khóa Exact-Version Policy trong `OfflineStorageRepository`
- **Files:** `apps/mobile/lib/features/offline/repositories/offline_storage_repository.dart`
- **Nội dung:** Thêm `Future<List<OfflineChapter>> getOfflineChaptersByChapterId(String chapterId)` trả về toàn bộ danh sách phiên bản của chương, sắp xếp theo `installed_at DESC`.

### Task 2: Hiện thực `OfflineContentResolver`
- **Files:** `apps/mobile/lib/features/offline/services/offline_content_resolver.dart`
- **Nội dung:**
  - `ResolvedOfflineChapter` model.
  - `resolveChapter({required String chapterId, String? preferredVersionId})`.
  - Exact-version matching & deterministic fallback.
  - Canonical manifest page sorting (không dùng `listSync`).
  - Novel content extraction & whitelisted illustration local path resolution.
  - Fail-closed khi verify payload thất bại.
  - Tạo synthetic `ChapterDetail` bind đúng `activeVersion.id = offlineChapter.chapterVersionId`.

### Task 3: Nâng cấp `ReaderImageCacheCoordinator`
- **Files:** `apps/mobile/lib/features/reader/presentation/reader_image_cache_coordinator.dart`
- **Nội dung:**
  - Thêm `registerLocalAssetFiles(Map<String, File>)` và `clearLocalAssetFiles()`.
  - Trong `getPageUrl(page)`: trả về đường dẫn tệp cục bộ nếu có, không gọi `MediaRepository`.
  - Trong `getImageProvider`: cấp phát `FileImage(file)` bọc trong `ResizeImage` cho local assets; không gọi 403 recovery cho tệp cục bộ.

### Task 4: Nâng cấp `ReaderSessionController` & `ReaderSessionState`
- **Files:**
  - `apps/mobile/lib/features/reader/presentation/reader_session_state.dart`
  - `apps/mobile/lib/features/reader/presentation/reader_session_controller.dart`
- **Nội dung:**
  - Thêm `enum ReaderTransportMode { online, offline }` và cờ `transportMode`.
  - Nhận `OfflineContentResolver?`.
  - `loadChapter(chapterId, {versionId, initialPageIndex})`: gọi resolver trước; nếu có kết quả, gán `transportMode = offline`, đăng ký local files vào coordinator và phát `ready`. Nếu không có hoặc payload hỏng, fallback sang online `_chapterRepository`.

### Task 5: Nâng cấp `ReadingProgressCoordinator` (Durable Replay Protocol)
- **Files:** `apps/mobile/lib/features/reader/presentation/reading_progress_coordinator.dart`
- **Nội dung:**
  - Trong `startSession(storyId)`: sau khi hydrate canonical server epoch, nếu `_pendingDraft == null`, đọc un-synced local checkpoint từ SharedPreferences, materialize pending draft với epoch mới và kích hoạt sync.

### Task 6: Nâng cấp `_NovelBlockWidget` & `ReaderScreen`
- **Files:**
  - `apps/mobile/lib/features/reader/presentation/novel_reader_view.dart`
  - `apps/mobile/lib/features/reader/presentation/reader_screen.dart`
- **Nội dung:**
  - `ReaderScreen`: nhận `versionId?` và `OfflineContentResolver?`. Chỉ bật server epoch hydration và gamification khi `transportMode == online`. Khi offline, nạp `novelHtmlContent` từ resolver.
  - `_NovelBlockWidget`: nếu `block.illustrationSrc` là tệp cục bộ, render `Image.file(File(path))`. Nếu ở chế độ offline và src là URL ngoại lai, render placeholder an toàn, không gọi `Image.network`.

### Task 7: Bộ Kiểm Thử Acceptance Gates Cho Phase 5D.5
- **Files:** `apps/mobile/test/features/reader/reader_offline_resolution_acceptance_test.dart`
- **Nội dung:** Hiện thực toàn bộ 8 Acceptance Gates. Chạy kiểm thử trên Docker container.

### Task 8: Đồng Bộ Roadmap, Git Commit & Đóng Issue #205
- Chạy toàn bộ test suite mobile và `flutter analyze`.
- Cập nhật `plans/phase_5d_offline_implementation_plan.md` và `plans/phases/phase_05_mobile_app.md`.
- `git add`, `git commit` và `git push`.
- `gh issue close 205`.
