# Kế hoạch Triển khai Phase 5D.5: Reader Offline Resolution (MOB-012 / Issue #205)

> **Trạng thái:** `FROZEN-FINAL` (Đã hoàn thành toàn diện 15 Verification Acceptance Gates, khóa kín toàn bộ 5 lỗ hổng P0 và 2 siết chặt P1).
> **Dành cho Agentic Workers:** Yêu cầu áp dụng quy chuẩn TDD, Clean Architecture, KISS & YAGNI, bảo toàn SSoT của Phase 5D.4 và Phase 5C. Tuân thủ nghiêm ngặt các Amendment P0 và các siết chặt P1.

**Mục tiêu:** Tích hợp bộ giải quyết nội dung ngoại tuyến thống nhất (`OfflineContentResolver`) vào 3 bộ máy đọc (Webtoon, Manga Paged, và Light Novel), đảm bảo khi chương đã được cài đặt hợp lệ trên máy, toàn bộ trải nghiệm đọc diễn ra với **0 network request** (kể cả presigned URL lookups, chapter API, progress epoch, novel content, gamification), bảo đảm exact-version identity, fail-closed khi payload bị hỏng, và lưu trữ / replay bền vững tiến độ đọc ngoại tuyến khi kết nối mạng trở lại mà tuyệt đối không phá vỡ các bất biến Phase 5C (anti-resurrection, tombstone epoch, newer server progress wins, unknown epoch protection, concurrent same-page race immunity, persisted epoch recovery across full process restart).

---

## 1. Các Bất Biến P0 và Siết Chặt P1 Đã Khóa

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
     - Cấp phát hình ảnh cục bộ qua `FileImage` / `Image.file`.

3. **P0.3 — Global Zero-Network Guard qua Gamification (`networkSideEffectsEnabled`):**
   - `ReadingProgressCoordinator` có explicit `networkSideEffectsEnabled` flag, được đồng bộ trực tiếp từ `transportMode` của Reader.
   - Khi ở chế độ offline (`networkSideEffectsEnabled == false`):
     - Ghi nhận `LocalReadingCheckpoint` (SharedPreferences) bình thường để bảo toàn tiến độ đọc.
     - Tuyệt đối **KHÔNG gọi Gamification Reward API** (`rewardReadChapter`) ngay cả khi đọc $\ge 45$ giây và tiến độ $\ge 80\%$.
     - Tuyệt đối **KHÔNG gọi Gamification Progression API** (`getProgression`) khi rollover nửa đêm hoặc khi app resume.
     - Tuyệt đối **KHÔNG hydrate epoch** hay kích hoạt sync lên server.
     - Đạt chuẩn 100% Zero-Network Invariant.

4. **P0.4 — Durable Replay Protocol & Anti-Resurrection (Phase 5C Alignment):**
   - `LocalReadingCheckpoint` mang đầy đủ metadata: `isDirty` (bool) và `baseWriteEpoch` (int?).
   - **Newer Server Progress Wins:** Khi reconnect, nếu `server.updatedAt >= local.updatedAt`, server luôn chiến thắng; local checkpoint cũ tuyệt đối không ghi đè server chỉ vì khác chapter/page.
   - **Tombstone Epoch Anti-Resurrection Guard:** Nếu local checkpoint được tạo dưới epoch $N$ (`baseWriteEpoch == N`), nhưng server hiện tại đã chuyển sang $M \ne N$ (do DELETE hoặc reset lịch sử đọc từ thiết bị khác): tuyệt đối không rebind hay auto-promote checkpoint cũ sang epoch mới để phục sinh lịch sử đã xóa.
   - **Replay Exactly-Once:** Sau khi replay thành công lên server với HTTP PUT, checkpoint cục bộ được cập nhật `isDirty = false`. Các lần khởi động lại app tiếp theo không phát sinh duplicate replay.

5. **P0.5 — Synthetic `ChapterDetail` Ràng Buộc Exact `chapterVersionId`:**
   - `OfflineContentResolver` tổng hợp `ChapterDetail` canonical từ `manifest.json`.
   - `ChapterDetail.activeVersion.id` bắt buộc phải là `offlineChapter.chapterVersionId`.
   - `storyId`, `chapterId`, `mediaFormat`, `versionNumber`, `language` được trích xuất từ manifest đã verify, không đoán mò từ route params.
   - `ReaderScreen._onProgressChanged()` ghi nhận đúng `chapterVersionId` canonical.

6. **P0.6 — Unknown Base Epoch Anti-Resurrection Guard (Cold-Start Offline Protection):**
   - Khi app được mở hoàn toàn offline từ cold-start mà chưa từng đồng bộ/hydrate epoch từ server, checkpoint được lưu với `baseWriteEpoch = null`.
   - Persist last-known canonical epoch theo user/story vào `SharedPreferences` khi tải truyện hoặc có mạng.
   - Khi thiết bị kết nối mạng trở lại, nếu `baseWriteEpoch == null` và server có tombstone/epoch $> 0$: **TUYỆT ĐỐI KHÔNG auto-promote hay rebind `null` sang `serverEpoch`**. Giữ checkpoint trên đĩa để user tiếp tục đọc cục bộ (local resume), nhưng không phát sinh bất kỳ HTTP PUT nào (0 PUT), chặn đứng 100% nguy cơ resurrect lịch sử đã xóa.

7. **P0.7 — Mutation Identity & Concurrent Same-Page Race Immunity:**
   - Định danh duy nhất cho từng local mutation bằng `checkpointRevision` (monotonic timestamp trong coordinator hiện tại), mang xuyên suốt `LocalReadingCheckpoint -> PendingReadingProgress -> network attempt`.
   - Khi HTTP PUT ACK thành công, chỉ đánh dấu `isDirty = false` khi `currentLocal.checkpointRevision == syncedDraft.checkpointRevision`.
   - Nếu người dùng tiếp tục cuộn đọc (kể cả trên cùng một trang) trong lúc PUT đang in-flight, mutation mới mang revision mới và bắt buộc giữ `isDirty = true`. Nếu app bị kill đột ngột, tiến độ mới nhất vẫn được bảo vệ và replay bền vững khi khởi động lại.

8. **P0.8 — Persisted Epoch Recovery Across Full Process Restart (Local-Only Bootstrap):**
   - `SharedPreferences` được inject trực tiếp vào `ReadingProgressRepository` qua `AppBootstrap` và `AppRouter`, đồng thời có lazy fallback tự động.
   - Bổ sung local-only bootstrap: `ReadingProgressCoordinator.startOfflineSession(storyId)` gọi `await repository.getLastKnownServerEpoch(storyId)` (0 HTTP request), nạp canonical epoch đã persist trên disk vào RAM trước khi bất kỳ mutation nào được ghi.
   - `ReaderScreen` gọi `startOfflineSession` ngay khi offline session ready.
   - `_persistEpoch()` được await nghiêm ngặt tại boundary nhận/ACK epoch mạng (`saveProgress`, `getProgress`, `ensureServerEpoch`), đảm bảo tính durable chống mất liveness sau crash.

9. **P1.1 — Strict Canonical Whitelist Cho Ảnh Minh Họa Novel:**
   - `ResolvedOfflineChapter` cung cấp tập hợp canonical `allowedIllustrationPaths` trích xuất từ `manifest.files`.
   - `_NovelBlockWidget` chỉ render ảnh cục bộ qua `Image.file` khi đường dẫn tuyệt đối nằm chính xác trong `allowedIllustrationPaths`. Mọi đường dẫn lạ (`/data/...`, `file:///...`, relative path ngoài whitelist) bị chặn hoàn toàn, ngăn chặn tấn công đọc trộm tệp tin hoặc rò rỉ dữ liệu.
   - URL mạng ngoài whitelist bị chặn khi ở chế độ offline, render placeholder sạch sẽ.

10. **P1.2 — Type-Safe Image Source & Loại Bỏ Xác Nhận "0 Latency" Vô Căn Cứ:**
    - `ReaderImageCacheCoordinator` nhận diện rõ nguồn tệp cục bộ (`_localAssetFiles`), không ép đường dẫn tệp đĩa thành URL giả mạo.
    - Ghi nhận chính xác: Offline resolver thực hiện xác thực toàn vẹn bằng SHA-256 từng tệp trên đĩa (`verifyFileHashes: true`) để đảm bảo Fail-Closed. Do đó, trải nghiệm là "Zero-Network / Local Disk" chứ không tự gán "0 latency" cho đến khi có số liệu benchmark thực tế trên thiết bị.

---

## 2. Ma Trận 15 Tiêu Chuẩn Nghiệm Thu (15 Acceptance Gates)

| Gate | Tiêu Chí Kiểm Tra (Acceptance Criteria) | Trạng Thái |
| :--- | :--- | :---: |
| **Gate 1: Exact-Version Selection** | Khi có `preferredVersionId`, exact-match version đó; khi `preferredVersionId == null`, chọn theo policy deterministic (`installedAt DESC, chapterVersionId DESC`). | `PASSED` |
| **Gate 2: Global Zero-Network (Webtoon & Manga)** | Toàn bộ các service (Chapter API, Media presigned URL, Progress epoch hydration, Gamification) thực hiện chính xác **0 network request**. Page order đúng theo manifest. | `PASSED` |
| **Gate 3: Novel Offline Resolution** | Nạp `content.html` offline, ảnh minh họa whitelisted render qua `Image.file`, ảnh ngoại lai không gửi request mạng. 0 HTTP calls. | `PASSED` |
| **Gate 4: Version-Bound Progress** | `ChapterDetail.activeVersion.id` khớp chính xác `chapterVersionId` đã cài; reading progress ghi nhận đúng `chapterVersionId`. | `PASSED` |
| **Gate 5: SSoT Proof Gate** | Task có status `READY` nhưng bảng `offline_chapters` thiếu row $\rightarrow$ resolver từ chối trả dữ liệu (`null`). | `PASSED` |
| **Gate 6: Runtime Corruption Fail-Closed** | Tệp bị xóa/tamper trên đĩa $\rightarrow$ fail-closed sang online nếu có mạng, hoặc báo lỗi sạch sẽ nếu Airplane Mode. | `PASSED` |
| **Gate 7: Offline $\rightarrow$ Reconnect Durable Progress Replay** | Đọc offline $\rightarrow$ kill app $\rightarrow$ mở lại khi online $\rightarrow$ hydrate server epoch canonical $\rightarrow$ replay local checkpoint với epoch an toàn. | `PASSED` |
| **Gate 8: App Restart Offline Resumption** | Khởi động lại ứng dụng, mở chương đã tải ngoại tuyến hoạt động tức thì từ local disk với 0 network request. | `PASSED` |
| **Gate 9: Offline Gamification Zero-Network** | Ở chế độ offline, đọc liên tục $> 45$s và đạt tiến độ $85\%$ ($> 80\%$) $\rightarrow$ phát sinh **0 HTTP request** (không reward, không progression). Local checkpoint vẫn lưu. | `PASSED` |
| **Gate 10: Newer Server Progress Wins** | Local checkpoint cũ hơn (ví dụ đọc chương 3 lúc 10h) không được phép ghi đè server progress mới hơn (ví dụ đã đọc chương 10 lúc 12h) chỉ vì khác chapter/page. | `PASSED` |
| **Gate 11: Tombstone Epoch Anti-Resurrection** | Local checkpoint tạo dưới epoch $N$, server đã xóa lịch sử và tăng epoch lên $N+1$ $\rightarrow$ tuyệt đối không rematerialize checkpoint với epoch $N+1$ rồi gửi. | `PASSED` |
| **Gate 12: Durable Replay Exactly-Once** | Sau khi local checkpoint được replay thành công lên server, checkpoint được đánh dấu `isDirty = false`. Khởi động lại app không gửi thêm bất kỳ PUT request nào. | `PASSED` |
| **Gate 13: Unknown Base Epoch Anti-Resurrection** | Cold-start offline session (`baseWriteEpoch = null`), remote DELETE tăng server epoch lên 2 $\rightarrow$ reconnect phát sinh **0 PUT request** (không rebind sang epoch mới, không resurrect). | `PASSED` |
| **Gate 14: Concurrent Same-Page Progress During PUT** | Mutation cùng trang phát sinh trong lúc PUT request in-flight $\rightarrow$ ACK không xóa dirty nhầm, checkpoint trên đĩa giữ `isDirty = true` và replay đầy đủ khi restart. | `PASSED` |
| **Gate 15: Persisted Epoch Recovery Across Process Restart** | Sau full process restart khi offline, `startOfflineSession` hydrate persisted epoch $N$ $\rightarrow$ offline mutation ghi `baseWriteEpoch = N` $\rightarrow$ Branch 1: reconnect server $N$ replay đúng 1 lần; Branch 2: reconnect server $N+1$ phát sinh 0 PUT. | `PASSED` |
| **P1.1: Strict Whitelist Verification** | Các đường dẫn ảnh ngoại lai không nằm trong `allowedIllustrationPaths` của manifest bị chặn, không đọc đĩa tùy tiện. | `PASSED` |
