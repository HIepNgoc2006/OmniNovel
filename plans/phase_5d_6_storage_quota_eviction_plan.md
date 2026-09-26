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
       created_at INTEGER NOT NULL
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

3. **P0.3 — Canonical User Isolation (DB Schema Migration v1 ➔ v2):**
   - Nâng cấp SQLite database từ version 1 lên version 2:
     - `offline_chapters`: Khóa composite `PRIMARY KEY (user_id, chapter_version_id)`, bổ sung `is_pinned INTEGER NOT NULL DEFAULT 0`.
     - `download_tasks`: Ràng buộc `UNIQUE(user_id, chapter_version_id)`.
     - Bổ sung bảng `offline_deletion_tombstones`.
   - Toàn bộ tầng repository (`OfflineStorageRepository`), queue manager (`DownloadQueueManager`), và resolver (`OfflineContentResolver`) đều bắt buộc user-scoped (`userId`).
   - Chuyển đổi tài khoản (Logout / Switch User) bảo đảm User B không thể xem, đọc hay can thiệp vào inventory của User A. Legacy v1 data được gán về `'anon'` an toàn.

4. **P0.4 — Namespace Filesystem Isolation (Cross-User Dedup Out-of-Scope):**
   - Loại trừ hoàn toàn cross-user physical deduplication khỏi phạm vi 5D.6 để tránh rủi ro reference-counting đa chủ sở hữu.
   - Phân vùng cấu trúc thư mục lưu trữ theo user scope: `files/offline/<userScope>/installed/<chapterVersionId>/` và `files/offline/<userScope>/staging/`.

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
| **Gate 1: DB Schema Migration v1 ➔ v2 & Canonical User Isolation** | Schema upgrade v1 ➔ v2 thành công; `offline_chapters` và `download_tasks` có khóa composite theo `user_id`; cô lập 100% repository, queue và resolver giữa các tài khoản; legacy data v1 fail-closed an toàn. |
| **Gate 2: Deterministic Deletion Tombstone Protocol & Crash Safety** | Mô phỏng crash tại mọi điểm ranh giới (trước khi purge file, sau khi purge file, trước khi xóa tombstone) $\rightarrow$ startup reconciliation tự động dọn sạch thư mục orphan, ghost row và hoàn tất cleanup. |
| **Gate 3: Deletion Tombstone vs. 5D.4 Recovery Precedence** | Khi thư mục tồn tại kèm deletion tombstone $\rightarrow$ purge thắng tuyệt đối; khi không có tombstone $\rightarrow$ kích hoạt đúng cơ chế crash recovery của 5D.4 (reconstruct row). |
| **Gate 4: Reader In-Use Lease Protection (Ref-Counted Token)** | Chương đang có active lease token từ Reader được bảo vệ 100% trước auto-LRU eviction; manual single delete và batch story deletion trả về lỗi `ChapterInUseException` (all-or-nothing). |
| **Gate 5: Deterministic LRU Eviction SSoT** | Thứ tự evict chính xác theo explicit never-read `CASE`, `last_read_at ASC`, `installed_at ASC`, `chapter_version_id ASC`; không bao giờ evict chương `is_pinned = 1` hoặc active reading checkpoint. |
| **Gate 6: Verified Storage Quota & Configurable Headroom Policy** | Quota tính toán trên verified `total_bytes`; auto-eviction kích hoạt khi vượt quota; chế độ Unlimited quota vẫn fail-closed nếu chạm ngưỡng OS disk headroom. |
| **Gate 7: Pre-Extraction TOCTOU Admission Guard** | Kiểm tra dung lượng thực tế qua `DiskSpaceProvider` ngay trước khi extract ZIP; nếu dung lượng đĩa tụt giảm giữa chừng lúc tải $\rightarrow$ hủy trích xuất an toàn, không gây tràn bộ nhớ. |
| **Gate 8: Manual Single & Batch Story Deletion** | Xóa thủ công 1 chương hoặc toàn bộ truyện dọn sạch mọi file payload, metadata DB và task hoàn tất không để lại rác. |
| **Gate 9: Zero-Regression Guard với Phase 5D.3–5D.5** | Toàn bộ các luồng tải Range resume, SSoT verification, Zero-Network offline reading và Durable Progress Replay (Gates 13/14/15) hoạt động bình thường, 0 lỗi hồi quy. |

---

## 4. Lộ Trình Triển Khai Chi Tiết (TDD Roadmap)

- **Bước 1 (Schema & Models):** Bump DB `databaseVersion = 2`, migration script v1 ➔ v2 trong `OfflineDatabase`, bổ sung bảng `offline_deletion_tombstones`, cập nhật model `OfflineChapter` (`userId`, `isPinned`) và `DownloadTask` (`userId`).
- **Bước 2 (User-Scoped Paths):** Cập nhật `OfflineStoragePaths` hỗ trợ `userScope` namespace (`files/offline/<userScope>/...`).
- **Bước 3 (DiskSpaceProvider & StoragePolicyConfig):** Xây dựng `DiskSpaceProvider` interface (kèm mock provider cho test) và `StoragePolicyConfig`.
- **Bước 4 (Reader In-Use Lease Manager):** Xây dựng `ReaderLeaseManager` quản lý ref-counted token in-memory.
- **Bước 5 (Deterministic Deletion Protocol):** Xây dựng `OfflineStorageManager` / `OfflineDeletionService` thực thi giao thức 3 bước (tombstone ➔ purge ➔ finalize) cho cả single chapter và batch story.
- **Bước 6 (Startup Reconciliation v2):** Nâng cấp startup reconciliation với luật precedence: tombstone purge thắng tuyệt đối, bảo toàn 5D.4 crash recovery khi không có tombstone.
- **Bước 7 (LRU Eviction Engine):** Hiện thực hóa truy vấn lọc ứng viên LRU với deterministic CASE ordering, pin exclusion, active checkpoint exclusion, và lease exclusion.
- **Bước 8 (Admission Guards):** Tích hợp kiểm tra quota/headroom tại `DownloadQueueManager.enqueueDownload` và pre-extraction recheck tại `BundleInstaller.installBundle`.
- **Bước 9 (Acceptance Test Suite):** Xây dựng `test/features/offline/storage_quota_eviction_acceptance_test.dart` xác minh toàn bộ 9 Gates.
- **Bước 10 (Verification & Review):** Chạy `flutter test`, `flutter analyze`, cập nhật kế hoạch, commit & push git, đóng Issue #206.
