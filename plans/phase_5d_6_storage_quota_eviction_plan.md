# Kế hoạch Triển khai Phase 5D.6: Storage Quota, LRU Eviction & Deterministic Deletion / User Isolation (MOB-013 / Issue #206)

> **Baseline xuất phát:** `90673f8` trên `main` (Phase 5D.5 đã niêm phong `FROZEN-FINAL ✅`, Issue #205 đã CLOSED).  
> **Trạng thái kế hoạch:** `IN-PROGRESS` — Sẵn sàng thực thi TDD.  
> **Triết lý kiến trúc:** Không tuyên bố transaction ảo xuyên suốt SQLite và OS filesystem; tuân thủ Cross-Domain Crash Protocol (Deterministic Protocol + Startup Reconciliation) kế thừa từ 5D.4; cô lập người dùng triệt để cả ở DB schema lẫn namespace tệp; lease bảo vệ reader là process-local reference-counted token.

---

## 1. Mười Bất Biến P0 Cốt Lõi (10 P0 Architectural Invariants)

1. **P0.1 — Cross-Domain Deletion Crash-Safety (Tombstone Protocol + Startup Reconciliation):**
   - Không tuyên bố transaction ảo giữa SQLite và OS Filesystem.
   - Thêm bảng riêng:
     ```sql
     CREATE TABLE offline_deletion_tombstones (
       tombstone_id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       chapter_version_id TEXT NOT NULL,
       created_at INTEGER NOT NULL,
       UNIQUE(user_id, chapter_version_id)
     );
     ```
   - Giữ nguyên bất biến 5D.4: `offline_chapters` **không có cột `status`**, row tồn tại chính là canonical proof sẵn sàng đọc offline.
   - **Giao thức xóa tất định 3 bước (3-Step Deletion Protocol):**
     - *Bước 1 (DB Atomic Revocation):* Transaction ghi tombstone vào `offline_deletion_tombstones` và xóa row khỏi `offline_chapters` $\rightarrow$ vô hiệu hóa availability tức thì; `OfflineContentResolver` fail-closed ngay lập tức nếu gặp tombstone.
     - *Bước 2 (Filesystem Purge):* Xóa thư mục payload vật lý `installed/<userScope>/<chapterVersionId>/`.
     - *Bước 3 (DB Finalize):* Xóa tombstone trong `offline_deletion_tombstones` và xóa bản ghi `download_tasks` của version đó để hoàn tất vòng đời.

2. **P0.2 — Deletion Tombstone vs. 5D.4 Recovery Precedence:**
   - Thứ tự ưu tiên đối soát khi khởi động (`Startup Reconciliation`):
     - **Tombstone Thắng Tuyệt Đối:** Nếu thư mục tồn tại và có deletion tombstone trong DB $\rightarrow$ lập tức purge filesystem, dọn sạch tombstone và task liên quan.
     - **5D.4 Crash Recovery:** Nếu không có tombstone, áp dụng recovery policy của 5D.4 (reconstruct row nếu có READY task và manifest hợp lệ).
     - **Orphan Purge:** Chỉ xóa thư mục vật lý nếu thực sự orphan (không có tombstone, không có task, và không thỏa mãn điều kiện phục hồi 5D.4).

3. **P0.3 — Canonical User Isolation & Fail-Closed Legacy v1 Migration:**
   - Nâng cấp SQLite database từ version 1 lên version 2:
     - `offline_chapters`: Khóa composite `PRIMARY KEY (user_id, chapter_version_id)`, bổ sung `is_pinned INTEGER NOT NULL DEFAULT 0`.
     - `download_tasks`: Ràng buộc `UNIQUE(user_id, chapter_version_id)`.
     - Bổ sung bảng `offline_deletion_tombstones` với `UNIQUE(user_id, chapter_version_id)`.
   - **Legacy v1 Ownership = UNKNOWN ➔ Fail-Closed:**
     - Dữ liệu v1 cũ không có bằng chứng canonical về user ownership.
     - Tuyệt đối **KHÔNG gán về `'anon'`**, không gán về current user.
     - Các row v1 không có ownership không được promote vào v2 inventory. Legacy unscoped files trên filesystem được purge an toàn qua cleanup; không cho phép cross-account data inheritance.
   - Toàn bộ tầng repository (`OfflineStorageRepository`), queue manager (`DownloadQueueManager`), và resolver (`OfflineContentResolver`) đều bắt buộc user-scoped (`userId`), không để tồn tại bất kỳ backdoor query toàn cục nào.

4. **P0.4 — Namespace Filesystem Isolation 3-Zone (Cross-User Dedup Out-of-Scope):**
   - Loại trừ hoàn toàn cross-user physical deduplication khỏi phạm vi 5D.6 để tránh rủi ro reference-counting đa chủ sở hữu.
   - Phân vùng cấu trúc thư mục lưu trữ theo `userScope` bao trùm cả 3 vùng:
     ```text
     files/offline/<userScope>/
       tmp/        # <chapterVersionId>.part
       staging/    # <chapterVersionId>/
       installed/  # <chapterVersionId>/
     ```
   - `userScope` được tính toán thông qua hàm canonical, stable và path-safe: `userScope = stableSafeScope(userId)` (SHA-256 hex truncated), tránh đưa identifier thô hoặc ký tự đặc biệt vào tên thư mục.

5. **P0.5 — Reader In-Use Lease Protection (Process-Local Ref-Counted Token):**
   - Triển khai cơ chế lease trong bộ nhớ: `acquireLease(chapterVersionId, {required String readerSessionId}) -> ReaderLeaseToken` và `releaseLease(ReaderLeaseToken token)`.
   - **LRU Auto-Eviction Bắt Buộc Bỏ Qua** mọi chương đang có lease active (ref-count $> 0$).
   - **Manual Deletion Fail-Closed:** Khi người dùng yêu cầu xóa chương đơn lẻ đang được Reader mount đọc $\rightarrow$ từ chối (throw `ChapterInUseException`). Khi xóa hàng loạt theo truyện (batch story deletion), nếu có bất kỳ chương nào đang leased $\rightarrow$ từ chối toàn bộ batch (all-or-nothing).

6. **P0.6 — Deterministic LRU Ordering & Exclusion Rules:**
   - `last_read_at` được cập nhật tại thời điểm Reader mở đọc thành công.
   - Loại trừ khỏi danh sách ứng viên eviction: chương đang có active lease, chương được ghim thủ công (`is_pinned = 1`), và chương đang có tiến độ đọc dở (`checkpoint.isDirty` hoặc `progressPercentage > 0` trong 7 ngày gần nhất).
   - Thứ tự eviction tất định không phụ thuộc implicit NULL:
     ```sql
     ORDER BY
       CASE WHEN last_read_at IS NULL THEN 0 ELSE 1 END ASC,
       last_read_at ASC,
       installed_at ASC,
       chapter_version_id ASC
     ```

7. **P0.7 — Verified Payload Size & Independent OS Disk Headroom:**
   - Quota của user được tính toán từ tổng `total_bytes` (verified payload size đã nén/giải nén chuẩn khi commit) của các chương thuộc user đó (`SUM(total_bytes) WHERE user_id = ?`).
   - Dung lượng đĩa khả dụng của hệ điều hành (`diskSpaceFree`) được quản lý độc lập thông qua interface `DiskSpaceProvider` có thể inject phục vụ TDD.

8. **P0.8 — Pre-Extraction TOCTOU Admission Guard:**
   - Đỉnh điểm chiếm dụng đĩa xảy ra khi đồng thời tồn tại file `.part` ZIP, thư mục giải nén `staging/` và dữ liệu `installed/`.
   - Kiểm tra dung lượng 2 lớp:
     - *Lớp 1 (Pre-enqueue):* Kiểm tra quota và ước lượng headroom trước khi đưa vào hàng đợi.
     - *Lớp 2 (Pre-extraction Recheck):* `BundleInstaller` kiểm tra lại dung lượng trống thực tế từ `DiskSpaceProvider` ngay trước khi giải nén gói ZIP sang `staging/`. Nếu không đủ headroom $\rightarrow$ fail-closed an toàn, không giải nén làm nghẽn bộ nhớ thiết bị.

9. **P0.9 — Clean Lifecycle Task Finalization:**
   - Khi xóa một chương đã cài đặt (thủ công hoặc LRU eviction), bản ghi `download_tasks` của phiên bản đó được dọn dẹp sạch sẽ trong cùng bước finalize với tombstone, đảm bảo lần tải sau tạo vòng đời mới hoàn toàn sạch.

10. **P0.10 — Zero-Regression với Phase 5D.3–5D.5:**
    - Không làm thay đổi hay suy yếu state machine của `DownloadQueueManager`, SSoT integrity của `BundleInstaller`, khả năng phân giải zero-network của `OfflineContentResolver`, và giao thức durable progress replay (Gates 13/14/15).

---

## 2. Chính Sách Dung Lượng Linh Hoạt (`StoragePolicyConfig`)

```dart
class StoragePolicyConfig {
  final int minFreeDiskHeadroomBytes; // Mặc định: 500 * 1024 * 1024 (500MB)
  final int? maxOfflineStorageBytes;  // null = Unlimited quota (vẫn giữ headroom guard)
  final double lowDiskWarningFraction; // 0.10 (cảnh báo khi headroom < 10%)

  const StoragePolicyConfig({
    this.minFreeDiskHeadroomBytes = 524288000, // 500MB
    this.maxOfflineStorageBytes,               // null = Unlimited
    this.lowDiskWarningFraction = 0.10,
  });
}
```

---

## 3. Ma Trận 9 Tiêu Chuẩn Nghiệm Thu (9 Verification Acceptance Gates)

| Gate | Tiêu Chí Kiểm Tra (Acceptance Criteria) |
| :--- | :--- |
| **Gate 1: DB Schema Migration v1 ➔ v2 & Canonical User Isolation** | **PASSED ✅ (14/14 tests)**<br>**Gate 1A (Schema Migration):** v1 ➔ v2, composite uniqueness `(user_id, chapter_version_id)`, tombstone uniqueness, legacy v1 fail-closed (không promote vào v2 inventory).<br>**Gate 1B (Repository Isolation):** User A/B có cùng `chapterVersionId` nhưng query/update/delete không cross-account.<br>**Gate 1C (Queue/Resolver/Path Isolation):** Cùng version ở A/B có task, `.part`, staging, installed độc lập hoàn toàn trong namespace `files/offline/<userScope>/`.<br>**Gate 1D (User Context Binding & Identifier Safety):** Loại bỏ hoàn toàn fallback anonymous/default user; khóa identity matching giữa Repository, Paths, Queue, Resolver, Installer; 64-hex SHA-256 `stableSafeScope`; `task_id` user-scoped `task_<userScope>_<versionId>_<micros>`. |
| **Gate 2: Deterministic Deletion Tombstone Protocol & Crash Safety** | Mô phỏng crash tại mọi điểm ranh giới (trước khi purge file, sau khi purge file, trước khi xóa tombstone) $\rightarrow$ startup reconciliation tự động dọn sạch thư mục orphan, ghost row và hoàn tất cleanup. |
| **Gate 3: Deletion Tombstone vs. 5D.4 Recovery Precedence** | Khi thư mục tồn tại kèm deletion tombstone $\rightarrow$ purge thắng tuyệt đối; khi không có tombstone $\rightarrow$ kích hoạt đúng cơ chế crash recovery của 5D.4 (reconstruct row). |
| **Gate 4: Reader In-Use Lease Protection & Deterministic Deletion Protocol** | **PASSED ✅ (5/5 tests)**<br>Chương đang có active lease token từ Reader được bảo vệ 100% trước deletion; manual single delete và batch story deletion trả về lỗi `ChapterInUseException` (All-or-Nothing); lease token in-memory ref-counted độc lập giữa các sessions; 3-step deletion protocol thực thi tất định dọn sạch filesystem và database sau khi release lease. |
| **Gate 5: Deterministic LRU Eviction SSoT** | Thứ tự evict chính xác theo explicit never-read `CASE`, `last_read_at ASC`, `installed_at ASC`, `chapter_version_id ASC`; không bao giờ evict chương `is_pinned = 1` hoặc active reading checkpoint. |
| **Gate 6: Verified Storage Quota & Configurable Headroom Policy** | **LOGIC GREEN 🟢 (Đang chờ platform provider production & DI wire-up)**<br>- **Headroom-Only Gate 6 Eviction:** Gate 6 pre-download admission chỉ bảo vệ physical disk headroom (`evictForDiskHeadroom`), tuyệt đối KHÔNG ép installed app quota bằng tệp nén.<br>- **Remaining-Unmaterialized Accounting (P0):** Ledger reservation chỉ đại diện cho byte chưa ghi xuống đĩa; cập nhật giảm khi tệp `.part` lớn lên trên filesystem, triệt tiêu lỗi double-counting.<br>- **State Semantics:** Task chỉ chuyển sang `DOWNLOADING` sau khi Gate 6 admission thành công. |
| **Gate 7: Pre-Extraction Central Directory Inspection & Dual Admission** | **PASSED ✅ (5/5 Acceptance Cases)**<br>- **7.1 Metadata Inspection:** Quét Central Directory headers trong isolate trước extraction, thu thập chính xác `entryCount` và `totalUncompressedBytes` với đúng 0 staging bytes trên đĩa; fail-closed trước Zip Slip / symlink / duplicate.<br>- **7.2 Headroom Fail-Closed:** Expansion khiến disk tụt dưới headroom reserve $\rightarrow$ từ chối cài đặt fail-closed, 0 staging bytes, task FAILED.<br>- **7.3 Installed Quota Assisted Eviction:** Vượt app quota $\rightarrow$ dọn dẹp LRU qua `OfflineDeletionService` $\rightarrow$ re-read DB usage và free disk $\rightarrow$ reserve $\rightarrow$ extract và commit thành công.<br>- **7.4 Concurrent Extraction:** Hai installer đồng thời không được overcommit chung quỹ physical headroom hay app quota.<br>- **7.5 Reservation Lifecycle:** Multi-ledger độc lập (`downloadReservations`, `extractionReservations`, `installQuotaReservations`), giải phóng đúng thời điểm (staging materialize $\rightarrow$ extraction release; SQLite commit $\rightarrow$ install quota release; cancel/fail $\rightarrow$ purge sạch). |
| **Gate 8: Manual Single & Batch Story Deletion** | Xóa thủ công 1 chương hoặc toàn bộ truyện dọn sạch mọi file payload, metadata DB và task hoàn tất không để lại rác. |
| **Gate 9: Zero-Regression Guard với Phase 5D.3–5D.5** | Toàn bộ các luồng tải Range resume, SSoT verification, Zero-Network offline reading và Durable Progress Replay (Gates 13/14/15) hoạt động bình thường, 0 lỗi hồi quy (280/280 tests passed). |

---

## 4. Lộ Trình Triển Khai Chi Tiết (TDD Roadmap)

- [x] **Bước 1A (Gate 1A — Schema Migration & Legacy v1 Fail-Closed) — HOÀN THÀNH:**
  - Viết Gate 1A RED test: Xác minh migration từ DB v1 sang v2, composite primary key `(user_id, chapter_version_id)` cho `offline_chapters`, uniqueness `(user_id, chapter_version_id)` cho `download_tasks` và `offline_deletion_tombstones`, và loại bỏ toàn bộ dữ liệu legacy v1 không có owner (fail-closed, không promote vào v2 inventory).
  - Nâng cấp `databaseVersion = 2` trong `OfflineDatabase`.
  - Viết migration script v1 ➔ v2 và v2 `onCreate` schema.
  - Cập nhật model: `OfflineChapter` (`userId`, `isPinned`), `DownloadTask` (`userId`), và model `OfflineDeletionTombstone`.
  - Đạt Gate 1A GREEN (4/4 tests passed).
- [x] **Bước 1B (Gate 1B — Repository User Isolation) — HOÀN THÀNH:**
  - Viết Gate 1B RED test: Xác minh User A và User B tải cùng `chapterVersionId` nhưng độc lập hoàn toàn về query, update, delete, isChapterInstalled, lastReadAt.
  - Bổ sung `userId` vào mọi method trong `OfflineStorageRepository` (`getOfflineChapter`, `getTaskById`, `updateTask`, `deleteTask`, `isChapterInstalled`, `updateLastReadAt`, `getOfflineChaptersByChapterId`...). Loại bỏ hoàn toàn mọi backdoor query toàn cục không có ownership.
  - Đạt Gate 1B GREEN (3/3 tests passed).
- [x] **Bước 1C (Gate 1C — Namespace Paths, Queue & Resolver Isolation) — HOÀN THÀNH:**
  - Viết Gate 1C RED test: Cùng version ở A và B có task riêng, file `.part` trong `tmp/` riêng, `staging/` riêng, và `installed/` riêng; resolver của User A không bao giờ giải quyết sang file của User B.
  - Cập nhật `OfflineStoragePaths` với hàm deterministic, path-safe `userScope = stableSafeScope(userId)`.
  - Phân vùng cấu trúc thư mục 3 vùng: `files/offline/<userScope>/{tmp, staging, installed}/`.
  - Cập nhật `DownloadQueueManager`, `BundleInstaller`, và `OfflineContentResolver` bind theo `userId` / `userScope`.
  - Đạt Gate 1C GREEN (3/3 tests passed).
- [x] **Bước 1D (Gate 1D — User Context Binding & Identifier Safety) — HOÀN THÀNH:**
  - Loại bỏ hoàn toàn fallback anonymous `userId`: `OfflineStorageRepository` và `OfflineStoragePaths` bắt buộc `required String userId`, ném `ArgumentError` nếu empty/whitespace.
  - Khóa identity context giữa Repository, StoragePaths, QueueManager, Resolver và Installer (ném `ArgumentError` nếu mismatch).
  - Tăng cường `stableSafeScope` lên full 64-hex SHA-256 (256-bit hash) triệt tiêu hoàn toàn rủi ro collision.
  - Định dạng lại `task_id` thành `task_<userScope>_<versionId>_<micros>` ngăn chặn race collision chéo user.
  - Đạt Gate 1D GREEN (4/4 tests passed).
- [x] **Bước 2 (DiskSpaceProvider & StoragePolicyConfig) — HOÀN THÀNH:**
  - Xây dựng thin interface `DiskSpaceProvider` (`Future<int> getFreeBytes(String path)`) và concrete class `DefaultDiskSpaceProvider`.
  - Xây dựng data-only injectable model `StoragePolicyConfig` (headroom 500MB, default unlimited quota, low disk fraction 0.10).
- [x] **Bước 3 (Reader In-Use Lease Manager) — HOÀN THÀNH:**
  - Xây dựng `ReaderLeaseManager` quản lý ref-counted token in-memory: token chứa `userId + chapterVersionId + readerSessionId + leaseId + acquiredAt`.
  - Hỗ trợ đa reader/đa session đồng thời, release idempotent, cách ly theo user, 100% in-memory không persist SQLite.
- [x] **Bước 4 (Deterministic Deletion Protocol & Lease Guard) — HOÀN THÀNH:**
  - Xây dựng `OfflineDeletionService` thực thi giao thức xóa tất định 3 bước (atomic revoke tombstone ➔ purge filesystem ➔ finalize cleanup) cho cả single chapter và batch story (All-or-Nothing).
  - Tích hợp lease guard: ném `ChapterInUseException` fail-closed nếu chapter đang có active lease.
  - Đạt Gate 4 GREEN (5/5 tests passed).
- [x] **Bước 5 (Startup Reconciliation v2) — HOÀN THÀNH:**
  - Nâng cấp startup reconciliation với luật precedence: tombstone purge thắng tuyệt đối, bảo toàn 5D.4 crash recovery khi không có tombstone (Gate 2, Gate 3).
- [x] **Bước 6 (LRU Eviction Engine & Gate 6 Hardening) — LOGIC GREEN:**
  - Hiện thực hóa truy vấn lọc ứng viên LRU với deterministic CASE ordering, pin exclusion, active checkpoint exclusion, và lease exclusion (Gate 5).
  - Triển khai `StorageAdmissionCoordinator` với `evictForDiskHeadroom` và remaining-unmaterialized accounting (Gate 6 logic green).
- [x] **Bước 7 (Gate 7 Pre-Extraction Inspection & Dual Admission) — HOÀN THÀNH:**
  - Central Directory inspection trước extraction trả `entryCount`, `totalUncompressedBytes` với 0 staging bytes.
  - Dual admission ledger: `extractionReservations` và `installQuotaReservations`.
  - Re-read DB usage và free disk sau LRU eviction, atomic reservation.
  - Đạt Gate 7 GREEN (5/5 acceptance cases passed).
- [ ] **Bước 8 (Acceptance Test Suite):** Hoàn thiện `test/features/offline/storage_quota_eviction_acceptance_test.dart` xác minh toàn bộ 9 Gates.
- [x] **Bước 9 (Zero-Regression & Code Quality) — HOÀN THÀNH:**
  - Chạy `flutter test`, xác nhận 280/280 tests passed không hồi quy.
- [ ] **Bước 10 (Verification & Review):** Commit & push git, cập nhật Living Tracker #192, đóng Issue #206.
