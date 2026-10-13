# 📱 Design Specification: Task 7B.3 — Mobile Client Integration (Account Claim & Scope Coordination)

> **Mã công việc:** Task 7B.3 (Mobile Client Integration)  
> **Trạng thái:** `READY FOR FINAL FROZEN REVIEW (4 P0 Blockers Resolved)`  
> **Căn cứ kỹ thuật:**
> - [plans/ROADMAP.md](ROADMAP.md) (Task 7B.3 Web = FROZEN CLEAN at `9f74ea1`, Hosted CI Run #435 Green 7/7)
> - [plans/product/identity_and_ownership_model.md](product/identity_and_ownership_model.md) (SSoT Identity & Ownership)
> - [plans/product/guest_to_account_claim_protocol.md](product/guest_to_account_claim_protocol.md) (SSoT Claim Protocol)
> - [plans/phase_07b_account_claim_implementation_plan.md](phase_07b_account_claim_implementation_plan.md) (Phase 7B Implementation Plan)

---

## 1. Tổng Quan & Mục Tiêu Kiến Trúc

Task 7B.3 Mobile Client Integration hoàn thiện luồng chuyển giao dữ liệu Khách sang Tài khoản (Guest-to-Account Claim) trên ứng dụng Flutter di động. Nhiệm vụ cốt lõi là bảo đảm **tính toàn vẹn dữ liệu, triệt tiêu race condition ghi đè tài khoản, chống tái sinh dữ liệu đã xóa (Anti-Resurrection), phân định ranh giới phục hồi sau sự cố (Crash Recovery)** và bảo toàn tính độc lập của phân vùng lưu trữ ngoại tuyến.

### 5 Nguyên Tắc Bất Biến Cốt Lõi (P0 Invariants)

1. **P0-1 — Thẩm Quyền Duy Nhất Mở Scope ACCOUNT (Zero-Bypass Architecture):**
   - `ActiveScopeCoordinator.onAuthStatusChanged(AuthStatus.authenticated)` **TUYỆT ĐỐI KHÔNG BAO GIỜ** được tự ý mở scope `account:<userId>`. Nhánh `authenticated` luôn chuyển sang `ActiveScopeState.transitioning` (`setTransitioning()`), khóa cứng `canMutateUserState = false`.
   - `GuestClaimCoordinator` là **thẩm quyền duy nhất (Single Finalization Authority)** được phép gọi `resolveToAccount(userId)` sau khi đã xác minh chắc chắn: (a) Không có dữ liệu khách, (b) Người dùng chọn Bỏ qua (Skip), hoặc (c) Claim đã commit và rebind local thành công.
   - `resolveToAccount(userId)` có kiểm tra nghiêm ngặt: Phải đang ở trạng thái `transitioning` và `userId` hợp lệ. Loại bỏ hoàn toàn các cờ lỏng lẻo như `deferScopeResolution`.
   - `GuestClaimBottomSheet` được điều phối từ tầng Root Application Shell (`AppShell` / Top-level Builder), không phụ thuộc vòng đời riêng của `LoginScreen` (vì GoRouter tự redirect khi `authenticated`).

2. **P0-2 — Scoped Authoritative Cloud Reconciliation & Single SQLite Transaction:**
   - Tuyệt đối không dùng giả định nguy hiểm "100 history đầu tiên để prune".
   - Phạm vi đối soát Authoritative Cloud Reconciliation được giới hạn chuẩn xác theo **danh sách `claimedStoryIds`** của phiên claim (tập hợp các `story_id` xuất hiện trong phân vùng khách).
   - Snapshot authoritative từ Cloud được fetch và xác minh tính toàn vẹn TRƯỚC KHI mở SQLite transaction.
   - Quá trình apply dữ liệu authoritative + merge guest data + purge phân vùng guest + hoàn tất journal diễn ra trong **CÙNG MỘT SQLite Transaction nguyên tử** (All-or-Nothing). Tuyệt đối không xóa phân vùng khách trước khi reconciliation hoàn tất.

3. **P0-3 — SQLite Recovery Journal Bền Vững (ACID Durability Thay Thế SharedPreferences):**
   - Loại bỏ hoàn toàn việc dùng `SharedPreferences` cho các pha phục hồi sự cố vì cơ chế ghi đĩa bất đồng bộ của nó không bảo đảm tính bền vững (durability) khi phương thức trả về.
   - Sử dụng bảng SQLite `guest_claim_recovery_journal` nằm trong cùng database `omninovel_offline.db`.
   - Lưu trữ bền vững checkpoint (bao gồm `conflictDecisions` và phase) bằng SQLite transaction **trước khi** gửi request `/commit`.
   - Phối hợp nguyên tử (Transactional Coordination): Bước hoàn tất (apply rebind + purge guest partition + xóa journal checkpoint) được thực hiện trong **CÙNG MỘT SQLite Transaction**, triệt tiêu nguy cơ split-brain giữa hai engine lưu trữ.

4. **P0-4 — SQLite Schema Mapping Đầy Đủ 12 Cột & Integer Milliseconds:**
   - SQLite Rebind bảo toàn trọn vẹn 12 cột của bảng `local_reading_progress` (bao gồm `device_timestamp` và `updated_at` dưới dạng số nguyên milliseconds `INTEGER NOT NULL`).
   - Xung đột tiến độ đọc: Nếu user chọn `KEEP_CLOUD`, ngay cả khi SQLite chưa cache Cloud progress thì Mobile vẫn lấy `conflict.cloudProgress` từ server (chuyển đổi ISO string sang integer milliseconds) ghi vào `account:<userId>`.
   - Cả `INSERT OR REPLACE` (khi conflict) và `INSERT OR IGNORE` (khi non-conflict) đều cung cấp đủ 12 cột kèm `device_timestamp` lấy từ sourceScope.
   - Kiểm thử round-trip từ model → SQLite → model bảo đảm `LocalReadingProgress.fromMap()` nhận đúng integer milliseconds và không bao giờ gặp lỗi `NOT NULL constraint failed`.

5. **P0-5 — Tách Rời SQLite Local Library Transaction Khỏi Offline Filesystem Handover:**
   - SQLite Transaction chỉ áp dụng nguyên tử cho 3 bảng của Local Library: `local_library_bookmarks`, `local_reading_progress`, `local_reading_history` cùng bảng `guest_claim_recovery_journal`.
   - Phân vùng file tải ngoại tuyến (`files/offline/<userScope>/...`) và bảng download (`offline_chapters`, `download_tasks`) được bảo toàn partition guest an toàn, không xóa và không blind-rename trong luồng claim thư viện.

---

## 2. Chi Tiết Thiết Kế Từng Tầng Kỹ Thuật

### 2.1. Tầng Trạng Thái & Điều Phối Định Danh (Identity & Scope State Machine)

#### `ActiveScopeCoordinator` ([apps/mobile/lib/core/identity/active_scope_coordinator.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/identity/active_scope_coordinator.dart))
- Bổ sung phương thức explicit:
  * `void setTransitioning()`: Đưa trạng thái sang `ActiveScopeState.transitioning`, set `_activeScope = null`, `canMutateUserState = false`, phát sự kiện `notifyListeners()`.
  * `void resolveToAccount(String userId)`:
    - **P0-1 Strict Validation:** Caller bắt buộc phải truyền `userId` hợp lệ (sau khi trim không được rỗng). Nếu rỗng -> fallback fail-closed về `bootstrapping`.
    - **Fail-Closed State Check:** Phải đang ở trạng thái `ActiveScopeState.transitioning` (ném `StateError` hoặc fail-closed nếu bị gọi ngoài luồng).
    - Thiết lập `_activeScope = 'account:$trimmed'`, `_state = ActiveScopeState.account`.
    - Flush toàn bộ waiters trong `_waiters`, phát sự kiện `notifyListeners()`.
  * Sửa đổi `onAuthStatusChanged(AuthStatus status, {String? userId})`:
    ```dart
    case AuthStatus.authenticated:
      final trimmed = userId?.trim();
      if (trimmed == null || trimmed.isEmpty) {
        _state = ActiveScopeState.bootstrapping;
        _activeScope = null;
        notifyListeners();
        break;
      }

      // P0-1 Invariant (Zero-Bypass):
      // Tuyệt đối KHÔNG tự mở scope ACCOUNT ở đây!
      // Luôn chuyển sang TRANSITIONING và khóa canMutateUserState = false.
      // Chỉ GuestClaimCoordinator (thẩm quyền duy nhất) mới được phép gọi resolveToAccount().
      setTransitioning();
      break;
    ```
    *(Đã loại bỏ hoàn toàn cờ `deferScopeResolution` và nhánh tự động gọi `resolveToAccount`)*.

#### `AuthScopeBridge` ([apps/mobile/lib/core/identity/auth_scope_bridge.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/identity/auth_scope_bridge.dart))
- **P0-1 Single Authority & Async Transition Ordering:**
  * `AuthScopeBridge` tuyệt đối **KHÔNG BAO GIỜ** được tự ý gọi `resolveToAccount(userId)`.
  * Khi `nextStatus == AuthStatus.authenticated`, `AuthScopeBridge` chuyển coordinator sang `setTransitioning()` thông qua `onAuthStatusChanged(AuthStatus.authenticated, userId: nextUserId)`.
  * Quyền mở `account:<userId>` duy nhất thuộc về `GuestClaimCoordinator`.
  * **Cơ chế chống Race Condition / Stale Callback:**
    - Sử dụng `transitionGeneration` counter: mỗi lần transition bắt đầu (hoặc logout), `transitionGeneration` tăng lên 1.
    - Bất kỳ tác vụ async I/O nào (quét SQLite, gọi prepare, commit, wait network) khi hoàn tất đều phải đối soát `capturedGeneration == currentGeneration`. Nếu phát hiện state đã đổi (ví dụ: người dùng logout hoặc phiên hết hạn giữa chừng), tác vụ async lập tức hủy bỏ (abort) và **không được phép** thay đổi coordinator hay mở account!
    - Khi `onLogout()` xảy ra: coordinator lập tức set `TRANSITIONING` -> xoay sang fresh `guestProfileId` -> chuyển sang `GUEST`. Mọi in-flight claim callback cũ của account bị vô hiệu hóa hoàn toàn.

---

### 2.2. SQLite Durable Recovery Journal & State Machine của Claim

#### Bảng SQLite Recovery Journal (`OfflineDatabase`)
Để đáp ứng chuẩn durability ACID 100% (thay vì bộ nhớ đệm bất đồng bộ của `SharedPreferences`), bảng `guest_claim_recovery_journal` được quản lý trực tiếp trong SQLite:
```sql
CREATE TABLE IF NOT EXISTS guest_claim_recovery_journal (
  claim_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  guest_profile_id TEXT NOT NULL,
  expected_state_fingerprint TEXT NOT NULL,
  conflict_decisions TEXT NOT NULL,
  phase TEXT NOT NULL,
  preview_data TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

#### Model `PendingGuestClaim` ([apps/mobile/lib/core/claim/models/pending_guest_claim.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/claim/models/pending_guest_claim.dart))
```dart
enum ClaimRecoveryPhase {
  prepared,           // Phase 1: /prepare 200 OK -> ĐÃ LƯU BỀN VỮNG VÀO SQLITE TRƯỚC KHI HIỂN THỊ BOTTOMSHEET
  committing,         // Phase 2: User chọn Claim -> ĐÃ LƯU DECISIONS VÀO SQLITE TRƯỚC KHI GỬI /commit
  committedServer,    // Phase 3: Server trả 200 COMMITTED -> Chuẩn bị thực hiện SQLite Rebind & Reconciliation
  rebindCompleted,    // Phase 4: SQLite Transaction & Cloud Reconciliation hoàn tất thành công
}

class PendingGuestClaim {
  final String claimId;
  final String userId;
  final String guestProfileId;
  final String expectedStateFingerprint;
  final Map<String, ConflictResolution> conflictDecisions;
  final ClaimRecoveryPhase phase;
  final String? previewDataJson;
  final DateTime createdAt;
  final DateTime updatedAt;

  const PendingGuestClaim({
    required this.claimId,
    required this.userId,
    required this.guestProfileId,
    required this.expectedStateFingerprint,
    this.conflictDecisions = const {},
    required this.phase,
    this.previewDataJson,
    required this.createdAt,
    required this.updatedAt,
  });

  Map<String, dynamic> toMap() => {
    'claim_id': claimId,
    'user_id': userId,
    'guest_profile_id': guestProfileId,
    'expected_state_fingerprint': expectedStateFingerprint,
    'conflict_decisions': jsonEncode(
      conflictDecisions.map((k, v) => MapEntry(k, v.value)),
    ),
    'phase': phase.name,
    'preview_data': previewDataJson,
    'created_at': createdAt.millisecondsSinceEpoch,
    'updated_at': updatedAt.millisecondsSinceEpoch,
  };

  factory PendingGuestClaim.fromMap(Map<String, dynamic> map);
  PendingGuestClaim copyWith({
    ClaimRecoveryPhase? phase,
    Map<String, ConflictResolution>? conflictDecisions,
    String? previewDataJson,
    DateTime? updatedAt,
  });
}
```

#### Quy Trình Ghi Bền Vững Từng Pha (Strict SQLite Durability Timeline)
1. **Sau khi `POST /prepare` thành công:**
   - Server trả về `GuestClaimPreviewResult`.
   - **BƯỚC BẮT BUỘC:** Lập tức ghi `PendingGuestClaim` (phase: `prepared`, decisions: `{}`) vào bảng SQLite `guest_claim_recovery_journal`.
   - **CHỈ SAU KHI** ghi SQLite thành công (disk flush hoàn tất), coordinator mới cập nhật `isOpen = true` để hiển thị `GuestClaimBottomSheet`. Đảm bảo nếu app bị crash/tắt ngay lúc này, recovery context đã an toàn 100% trên đĩa.
2. **Khi người dùng bấm "Gộp vào tài khoản" (Confirm):**
   - Thu thập các lựa chọn xung đột `conflictDecisions`.
   - **BƯỚC BẮT BUỘC:** Ghi cập nhật `PendingGuestClaim` (phase: `committing`, decisions: `conflictDecisions`) vào SQLite `guest_claim_recovery_journal`.
   - **CHỈ SAU KHI** lưu SQLite thành công, mới bắt đầu gửi HTTP request `POST /api/v1/account/guest-claims/:claimId/commit`.
3. **Khi Server trả về `200 OK (COMMITTED)`:**
   - Cập nhật phase: `committedServer` vào SQLite journal.
4. **Authoritative Cloud Reconciliation & Verification:**
   - Truy vấn snapshot authoritative từ Cloud cho đúng danh sách `claimedStoryIds` (xem chi tiết mục 2.3.1).
   - Xác minh toàn vẹn snapshot trong bộ nhớ thành công TRƯỚC KHI chạm vào dữ liệu SQLite.
5. **Atomic SQLite Transaction (Rebind + Purge + Journal Finalization):**
   - Thực thi MỘT transaction duy nhất:
     * Rebind bookmarks, progress (12 cột), history vào `account:<userId>`.
     * Purge sạch phân vùng `guest:<guestProfileId>`.
     * Xóa bản ghi (hoặc cập nhật `rebindCompleted`) trong `guest_claim_recovery_journal`.
6. **Mở Quyền Truy Cập:**
   - Gọi `resolveToAccount(userId)` để mở `canMutateUserState = true`.

#### Ma Trận Xử Lý Crash Recovery ([core/claim/guest_claim_coordinator.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/claim/guest_claim_coordinator.dart))
| Tình huống kiểm tra | Trạng thái máy chủ | Hành vi Mobile thực thi |
|---|---|---|
| `pending.userId != currentUserId` | Bất kỳ | Không can thiệp, bỏ qua claim của user khác, bảo vệ isolation |
| Normal Crash Recovery | `COMMITTED` | Kéo authoritative snapshot cho `claimedStoryIds`, chạy atomic SQLite rebind + purge + delete journal, gọi `resolveToAccount` |
| Normal Crash Recovery | `PREPARED` | Giữ scope `TRANSITIONING`, đọc preview data từ SQLite journal, mở lại `GuestClaimBottomSheet` kèm decisions |
| Normal Crash Recovery | `EXPIRED` hoặc `ABORTED` | Nếu SQLite khách vẫn còn dữ liệu: tạo phiên prepare mới; xóa journal cũ; không tự ý bỏ qua |
| Kiểm tra status mất mạng / offline | Lỗi mạng | Giữ nguyên scope `TRANSITIONING` (`PENDING_UNAVAILABLE`), cung cấp nút Thử lại |
| Lỗi mạng khi đang gửi `/commit` | Timeout / 5xx | Gọi `GET /status` kiểm tra xem commit đã vào DB server chưa trước khi quyết định retry hay rebind |
| Lỗi SQLite Rebind nội bộ | Exception | Rollback transaction tự động; SQLite journal giữ nguyên, cho phép thử lại an toàn |
| **Xóa Recovery Journal** | Chỉ khi hoàn tất 100% | Chỉ xóa journal row trong cùng transaction với rebind và purge guest partition |

---

### 2.3. SQLite Transactional Rebind & Schema Mapping Chuẩn 12 Cột

#### Phương thức tại `LocalLibraryDao` ([apps/mobile/lib/core/storage/local_library_dao.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/storage/local_library_dao.dart))
1. **`hasGuestData(String ownerScope) -> Future<bool>`:**
   - Đếm số bản ghi trong `local_library_bookmarks`, `local_reading_progress`, `local_reading_history` của `ownerScope`.
   - **Fail-Closed:** Nếu câu truy vấn SQLite throw exception, lập tức rethrow, không trả `false` giả tạo.
2. **`getClaimedStoryIds(String ownerScope) -> Future<Set<String>>`:**
   - Trích xuất toàn bộ tập hợp `story_id` phân biệt từ 3 bảng của `ownerScope` để làm phạm vi scoped đối soát.
3. **`rebindScope({...}) -> Future<void>`:**
   ```dart
   Future<void> rebindScope({
     required String sourceScope,
     required String targetScope,
     Map<String, ConflictResolution>? conflictDecisions,
     List<ReadingProgressConflict>? previewConflicts,
     Map<String, LocalReadingProgress>? authoritativeCloudProgress,
   }) async {
     await _db.transaction((txn) async {
       // 1. Bookmarks: INSERT OR IGNORE chống crash Primary Key (owner_scope, story_id)
       await txn.execute('''
         INSERT OR IGNORE INTO local_library_bookmarks (owner_scope, story_id, title, slug, cover_url, created_at)
         SELECT ?, story_id, title, slug, cover_url, created_at
         FROM local_library_bookmarks
         WHERE owner_scope = ?
       ''', [targetScope, sourceScope]);

       // 2. Reading History: Monotonic MAX merge
       await txn.execute('''
         INSERT INTO local_reading_history (
           owner_scope, story_id, chapter_id, chapter_version_id,
           story_title, story_slug, story_cover_url, chapter_number,
           chapter_title, progress_percentage, last_read_at
         )
         SELECT ?, story_id, chapter_id, chapter_version_id,
                story_title, story_slug, story_cover_url, chapter_number,
                chapter_title, progress_percentage, last_read_at
         FROM local_reading_history
         WHERE owner_scope = ?
         ON CONFLICT(owner_scope, story_id, chapter_id) DO UPDATE SET
           progress_percentage = MAX(local_reading_history.progress_percentage, EXCLUDED.progress_percentage),
           last_read_at = MAX(local_reading_history.last_read_at, EXCLUDED.last_read_at)
       ''', [targetScope, sourceScope]);

       // 3. Reading Progress: Conflict-Aware, Cloud Precedence & Đầy Đủ 12 Cột
       // 3a. Xử lý các truyện bị conflict:
       final conflicts = previewConflicts ?? const [];
       final processedConflictStoryIds = <String>{};

       for (final conflict in conflicts) {
         processedConflictStoryIds.add(conflict.storyId);
         final decision = conflictDecisions?[conflict.storyId] ?? ConflictResolution.keepCloud;

         final isCloud = decision == ConflictResolution.keepCloud;
         final p = isCloud ? conflict.cloudProgress : conflict.guestProgress;

         // Chuyển đổi timestamp ISO string từ server sang integer milliseconds
         final int updatedAtMs = DateTime.tryParse(p.updatedAt ?? '')?.toUtc().millisecondsSinceEpoch
             ?? DateTime.now().toUtc().millisecondsSinceEpoch;
         final int deviceTimestampMs = updatedAtMs;

         // P0-1: Đầy đủ 12 cột NOT NULL, không thiếu device_timestamp và updated_at
         await txn.rawInsert('''
           INSERT OR REPLACE INTO local_reading_progress (
             owner_scope, story_id, chapter_id, chapter_version_id, reading_mode,
             progress_percentage, scroll_position, page_index, anchor_block_id,
             text_offset, updated_at, device_timestamp
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ''', [
           targetScope,
           conflict.storyId,
           p.chapterId,
           p.chapterVersionId,
           p.readingMode.value,
           p.progressPercentage,
           p.scrollPosition,
           p.pageIndex >= 1 ? p.pageIndex : 1,
           p.anchorBlockId,
           p.textOffset,
           updatedAtMs,
           deviceTimestampMs,
         ]);
       }

       // 3b. Xử lý các truyện không conflict:
       // P0-1: INSERT OR IGNORE đầy đủ 12 cột bao gồm device_timestamp từ sourceScope
       await txn.execute('''
         INSERT OR IGNORE INTO local_reading_progress (
           owner_scope, story_id, chapter_id, chapter_version_id, reading_mode,
           progress_percentage, scroll_position, page_index, anchor_block_id,
           text_offset, updated_at, device_timestamp
         )
         SELECT ?, story_id, chapter_id, chapter_version_id, reading_mode,
                progress_percentage, scroll_position, page_index, anchor_block_id,
                text_offset, updated_at, device_timestamp
         FROM local_reading_progress
         WHERE owner_scope = ?
       ''', [targetScope, sourceScope]);

       // 4. Áp dụng authoritative Cloud progress cho các truyện trong claimed scope (nếu có)
       if (authoritativeCloudProgress != null) {
         for (final entry in authoritativeCloudProgress.entries) {
           final p = entry.value;
           await txn.rawInsert('''
             INSERT OR REPLACE INTO local_reading_progress (
               owner_scope, story_id, chapter_id, chapter_version_id, reading_mode,
               progress_percentage, scroll_position, page_index, anchor_block_id,
               text_offset, updated_at, device_timestamp
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ''', [
             targetScope, p.storyId, p.chapterId, p.chapterVersionId, p.readingMode,
             p.progressPercentage, p.scrollPosition, p.pageIndex, p.anchorBlockId,
             p.textOffset, p.updatedAt.millisecondsSinceEpoch, p.deviceTimestamp.millisecondsSinceEpoch,
           ]);
         }
       }

       // 5. Purge sạch phân vùng nguồn guest (chỉ thực hiện khi rebind thành công)
       await txn.delete('local_library_bookmarks', where: 'owner_scope = ?', whereArgs: [sourceScope]);
       await txn.delete('local_reading_progress', where: 'owner_scope = ?', whereArgs: [sourceScope]);
       await txn.delete('local_reading_history', where: 'owner_scope = ?', whereArgs: [sourceScope]);

       // 6. Xóa recovery journal checkpoint
       await txn.delete('guest_claim_recovery_journal', where: 'guest_profile_id = ?', whereArgs: [sourceScope.replaceFirst('guest:', '')]);
     });
   }
   ```

#### 2.3.1. Scoped Authoritative Cloud Reconciliation & Chống Hồi Sinh (P0-2 & P0-4)
Thay vì dùng giả định nguy hiểm "100 history đầu tiên để prune":
1. **Định Danh Phạm Vi Đối Soát Cụ Thể (`claimedStoryIds`):**
   - Phạm vi đối soát được xác định chính xác từ danh sách các `story_id` có trong phân vùng khách trước khi claim (`local_library_bookmarks`, `local_reading_progress`, `local_reading_history`).
   - Tuyệt đối không suy đoán hay prune các truyện ngoài phạm vi phiên claim của khách.
2. **Xác Minh Snapshot Authoritative Trước (Pre-Transaction Verification):**
   - Sau khi `POST /commit` thành công (PostgreSQL đã là SSoT xử lý triệt để tombstone và resolve conflicts):
   - Nếu `previewData.readStatesIgnoredAntiResurrectionCount > 0`:
     Backend đã từ chối một số truyện do Cloud có Tombstone xóa lịch sử.
     Mobile gọi endpoint authoritative theo phạm vi `claimedStoryIds` (hoặc đối soát danh sách truyện được chấp nhận trong claim result).
   - Snapshot authoritative được tải về và xác minh tính hợp lệ trong bộ nhớ (memory) TRƯỚC KHI mở transaction SQLite.
3. **Thực Thi Nguyên Tử Apply & Purge Trong Cùng SQLite Transaction:**
   - Dữ liệu authoritative được chuyển vào `rebindScope` như một tham số đầu vào.
   - Toàn bộ quá trình:
     * Ghi nhận bookmarks của khách vào tài khoản (chống trùng PK).
     * Sáp nhập lịch sử theo monotonic MAX.
     * Áp dụng tiến độ đọc (đủ 12 cột, integer milliseconds) theo conflict decision và authoritative snapshot.
     * **PURGE** sạch phân vùng nguồn `guest:<guestProfileId>` trong SQLite.
     * Xóa bản ghi checkpoint trong `guest_claim_recovery_journal`.
   - Diễn ra nguyên tử trong **MỘT TRANSACTION SQLITE DUY NHẤT**.
   - Nếu xảy ra sự cố mạng trước khi lấy xong snapshot: Phân vùng khách và tài khoản hoàn toàn không bị thay đổi (không xóa partition khách trước), journal giữ nguyên `committedServer`, sẵn sàng thử lại an toàn khi có mạng.
4. **Xử Lý Mất Mạng Khi Đang Reconcile (Network Failure Hardening):**
   - Nếu commit server thành công nhưng mạng bị ngắt trước hoặc trong khi reconcile:
     * `PendingGuestClaim` vẫn giữ nguyên ở phase `committedServer` trong SQLite recovery journal.
     * Điều phối viên **KHÔNG** xóa recovery context và **KHÔNG** mở account.
     * Người dùng thấy thông báo mạng kèm nút **"Thử lại đồng bộ (Retry)"**.
     * Khi khôi phục mạng hoặc khởi động lại ứng dụng: Crash recovery phát hiện phase `committedServer`, tự động chạy lại reconciliation hoàn tất, sau đó mới xóa journal và mở `ACCOUNT`.

---

### 2.4. Ranh Giới Nội Dung Ngoại Tuyến (Offline Filesystem Handover)

1. **Cô lập Transaction:** Thao tác SQLite rebind ở trên **tuyệt đối không** bao gồm các lệnh filesystem I/O di chuyển thư mục `files/offline/<userScope>`.
2. **Nguyên tắc bảo toàn partition:**
   - Thư mục offline của guest được bảo toàn nguyên trạng, không thực hiện blind rename hoặc xóa hàng loạt.
   - Khi người dùng đăng nhập và claim, các quyền đọc chương đã tải được duy trì truy cập dựa trên installation token cục bộ mà không làm rách nát dữ liệu staging hay installed.

---

### 2.5. Tầng Giao Diện & Điều Phối Ứng Dụng (Presentation & Orchestration)

1. **`GuestClaimBottomSheet` ([apps/mobile/lib/features/claim/presentation/guest_claim_bottom_sheet.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/features/claim/presentation/guest_claim_bottom_sheet.dart)):**
   - Được bọc trong `PopScope(canPop: false)`: Chặn thao tác Back của Android khi claim đang pending hoặc đang commit. Người dùng bắt buộc phải chọn dứt khoát `Gộp vào tài khoản` hoặc `Bỏ qua`.
   - Hiển thị danh sách conflict trực quan (Cloud vs Máy này) kèm Radio chọn giải pháp.
   - Xử lý lỗi mạng: Hiển thị thông báo lỗi rõ ràng và nút `Thử lại (Retry)` thay vì bị treo ở loading spinner vô hạn.
2. **Root Application Shell Orchestration:**
   - Gắn `GuestClaimBottomSheetListener` tại tầng Root Widget của ứng dụng (`OmniNovelApp` hoặc Shell của `GoRouter`).
   - Lắng nghe `GuestClaimCoordinator.isOpen`: Khi `isOpen == true`, tự động gọi `showModalBottomSheet(isDismissible: false, enableDrag: false)`.
   - Nhờ đó, việc điều phối claim hoàn toàn độc lập với việc `LoginScreen` bị dismiss hay `GoRouter` chuyển trang sau đăng nhập.

---

### 2.6. Đồng Bộ Điểm Vào Xác Thực (Auth Registration Entrypoint)

- Mở rộng [`AuthService`](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/auth/auth_service.dart) với hàm `register({username, email, password})`:
  * Gọi `POST /auth/register` (với auto-login semantics tương đương login).
  * Lưu trữ access token và refresh token.
  * Đặt trạng thái `authenticated` và cùng đi qua một orchestration entrypoint duy nhất để kích hoạt Guest Claim.

---

## 3. Ma Trận Kiểm Thử Chấp Nhận (12 Cross-Layer Acceptance Tests)

| # | Kịch Bản Kiểm Thử | Kỳ Vọng Đạt Được (Expected Outcome) |
|---|---|---|
| **AC-01** | Đăng nhập/Đăng ký thành công, trước khi `checkAndPrepareClaim` xong | Scope giữ nguyên `TRANSITIONING`, `canMutateUserState == false`. Cấm mọi thao tác ghi dữ liệu account. |
| **AC-02** | GoRouter redirect người dùng khỏi màn hình `/login` | `GuestClaimBottomSheet` vẫn hiển thị bình thường ở tầng Root Shell, không bị hủy khi `LoginScreen` unmount. |
| **AC-03** | Khởi động ứng dụng (Cold start) khi đang có `pendingClaim` | Bootstrap khởi tạo xong Router bình thường (`bootstrapReady`), không bị deadlock chờ `waitForResolvedScope()`. |
| **AC-04** | Ứng dụng sập (Crash) ngay sau khi máy chủ trả `200 OK (COMMITTED)` | Khi khởi động lại, recovery đọc context từ SQLite journal, tiếp tục thực hiện SQLite rebind idempotent và dọn partition nguồn thành công. |
| **AC-05** | Ứng dụng sập khi SQLite transaction đang chạy dở dang | SQLite transaction tự rollback toàn bộ, không có dữ liệu chắp vá; SQLite journal giữ nguyên để thử lại. |
| **AC-06** | Ứng dụng sập sau khi SQLite commit xong nhưng chưa kịp xóa recovery context | Khi khởi động lại, kiểm tra idempotency của SQLite rebind, dọn dẹp an toàn và xóa recovery journal, mở ACCOUNT. |
| **AC-07** | Người dùng chọn `KEEP_CLOUD` nhưng SQLite chưa từng cache progress của truyện đó | SQLite ghi đúng `conflict.cloudProgress` từ server (đầy đủ 12 cột, integer milliseconds) vào `account:<userId>`, không bị null hoặc ghi đè sai. |
| **AC-08** | Server từ chối tiến độ đọc vì truyện đã có Tombstone trên Cloud | Quá trình scoped reconciliation không tái sinh (resurrect) reading history hoặc progress của truyện đó vào `account:<userId>`. |
| **AC-09** | Gọi `/auth/me` gặp lỗi mạng tạm thời trong khi đang có recovery context | Không xem là logout, không rotate `guestProfileId`, giữ nguyên recovery context để khôi phục khi có mạng. |
| **AC-10** | Tài khoản A có pending claim, sau đó đăng xuất và đăng nhập Tài khoản B | Không áp dụng claim của Tài khoản A lên Tài khoản B. Phân định rạch ròi theo `pending.userId`. |
| **AC-11** | Sự cố thao tác tệp ngoại tuyến (nếu có) | Không gây gián đoạn hoặc xóa hỏng các gói chương tải offline của guest. |
| **AC-12** | Người dùng chủ động chọn "Bỏ qua" (Skip) | Thêm `guestProfileId` vào danh sách marker SharedPreferences, giữ nguyên 100% partition SQLite `guest:<guestProfileId>`, mở ACCOUNT. |

---

## 4. Kế Hoạch Triển Khai Tuần Tự (Phased Implementation Plan)

1. **Phase 1: Contracts Hardening & SQLite Recovery Journal Models**
   - Triển khai `PendingGuestClaim` model hỗ trợ `toMap` / `fromMap` cho SQLite, enum `ClaimRecoveryPhase`.
   - Tạo schema `guest_claim_recovery_journal` trong `OfflineDatabase`.
   - Hardening `guest_claim_models.dart`: fail-closed `GuestClaimStatus.fromString()`, validate 64-char fingerprint, 1-based `pageIndex`.
2. **Phase 2: Identity Scope & Single Authority Coordinator (Zero-Bypass)**
   - Cập nhật `ActiveScopeCoordinator`: `setTransitioning()`, `resolveToAccount()` đóng hoàn toàn bypass trong `onAuthStatusChanged`.
   - Cập nhật `AuthScopeBridge`: chuyển quyền quyết định mở account cho claim coordinator, bảo vệ bởi `transitionGeneration`.
   - Cập nhật `AuthService`: bổ sung `register()` đồng bộ với auto-login semantics.
3. **Phase 3: SQLite DAO Rebind (12 Cột) & Scoped Authoritative Reconcile**
   - Triển khai `hasGuestData(ownerScope)` (fail-closed) và `getClaimedStoryIds(ownerScope)`.
   - Triển khai `rebindScope` trong `LocalLibraryDao`: đầy đủ 12 cột cho progress, chuyển đổi integer milliseconds, apply authoritative cloud snapshot, atomic purge partition khách và delete recovery journal trong cùng 1 transaction.
   - Kiểm thử round-trip model → SQLite → model.
4. **Phase 4: GuestClaimCoordinator Engine & Durable Crash Recovery**
   - Triển khai `GuestClaimCoordinator`: `checkAndPrepareClaim`, `confirmClaim`, `skipClaim`, `checkCrashRecovery`.
   - Lưu trữ `PendingGuestClaim` vào SQLite journal trước khi mở dialog và trước khi commit.
   - Điều phối scoped reconciliation cho đúng `claimedStoryIds`, xử lý 409 re-prepare, xử lý 5xx/timeout status check.
5. **Phase 5: Presentation & Root Shell Orchestration (`GuestClaimBottomSheet`)**
   - Tách biệt `bootstrapReady` khỏi `scopeResolved` trong `app/bootstrap.dart`.
   - Tạo `GuestClaimBottomSheet` (kèm `PopScope`, conflict comparator view, retry button).
   - Tích hợp listener điều phối tại tầng Root Shell.
6. **Phase 6: Comprehensive Testing Suite & Regression Verification**
   - Unit tests cho Coordinator & SQLite Recovery Journal.
   - Integration tests cho DAO Rebind (PK collision, 12 cột, rollback, monotonic MAX).
   - Widget tests cho BottomSheet (`PopScope`, conflict choice, error retry).
   - 12 Acceptance Scenarios verification + chạy full `flutter test` bảo đảm 410+ tests PASS 100%.
