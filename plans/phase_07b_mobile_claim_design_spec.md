# 📱 Design Specification: Task 7B.3 — Mobile Client Integration (Account Claim & Scope Coordination)

> **Mã công việc:** Task 7B.3 (Mobile Client Integration)  
> **Trạng thái:** `FINAL AMENDMENT REVIEW — READY FOR FROZEN SIGNOFF`  
> **Căn cứ kỹ thuật:**
> - [plans/ROADMAP.md](ROADMAP.md) (Task 7B.3 Web = FROZEN CLEAN at `9f74ea1`, Hosted CI Run #435 Green 7/7)
> - [plans/product/identity_and_ownership_model.md](product/identity_and_ownership_model.md) (SSoT Identity & Ownership)
> - [plans/product/guest_to_account_claim_protocol.md](product/guest_to_account_claim_protocol.md) (SSoT Claim Protocol)
> - [plans/phase_07b_account_claim_implementation_plan.md](phase_07b_account_claim_implementation_plan.md) (Phase 7B Implementation Plan)

---

## 1. Tổng Quan & Mục Tiêu Kiến Trúc

Task 7B.3 Mobile Client Integration hoàn thiện luồng chuyển giao dữ liệu Khách sang Tài khoản (Guest-to-Account Claim) trên ứng dụng Flutter di động. Nhiệm vụ cốt lõi là bảo đảm **tính toàn vẹn dữ liệu, triệt tiêu race condition ghi đè tài khoản, chống tái sinh dữ liệu đã xóa (Anti-Resurrection), phân định ranh giới phục hồi sau sự cố (Crash Recovery)** và bảo toàn tính độc lập của phân vùng lưu trữ ngoại tuyến.

### 5 Nguyên Tắc Bất Biến Cốt Lõi (P0 Invariants)

1. **P0-1 — Thẩm Quyền Duy Nhất Mở Scope ACCOUNT (Zero-Bypass Architecture & Generation Guard):**
   - `ActiveScopeCoordinator.onAuthStatusChanged(AuthStatus.authenticated)` **TUYỆT ĐỐI KHÔNG BAO GIỜ** được tự ý mở scope `account:<userId>`. Nhánh `authenticated` luôn chuyển sang `ActiveScopeState.transitioning` (`setTransitioning()`), khóa cứng `canMutateUserState = false`.
   - `GuestClaimCoordinator` là **thẩm quyền duy nhất (Single Finalization Authority)** được phép gọi `resolveToAccount(userId, {required int expectedGeneration})` sau khi đã xác minh chắc chắn: (a) Không có dữ liệu khách, (b) Người dùng chọn Bỏ qua (Skip), hoặc (c) Claim đã commit và rebind local thành công.
   - `resolveToAccount` bắt buộc kiểm tra đồng thời: `_state == ActiveScopeState.transitioning` và `expectedGeneration == _transitionGeneration`. Stale callback từ các tác vụ async cũ hoặc từ tài khoản trước bị hủy bỏ ngay lập tức.
   - `GuestClaimBottomSheet` được điều phối từ tầng Root Application Shell (`AppShell` / Top-level Builder), không phụ thuộc vòng đời riêng của `LoginScreen`.

2. **P0-2 — Authoritative Cloud Reconciliation (Phương Án A — Backend Finalization Contract & PostgreSQL Durability):**
   - Loại bỏ hoàn toàn mọi phỏng đoán heuristic (như giả định 100 history gần nhất).
   - **Backend Prerequisite Gate:** Cần cập nhật đồng bộ backend DTOs, Shared TypeScript types, Dart mirror, commit/status APIs và regression tests trước khi tích hợp Mobile DAO/Coordinator:
     * Snapshot `finalization` được lưu bền vững vào bảng PostgreSQL `guest_claims` (`finalization_data` JSONB) trong cùng transaction `COMMITTED`, bảo đảm retry `/commit` và `GET /status` trả về kết quả nhất quán 100% ngay cả khi server khởi động lại.
     * Sửa lỗ hổng Global Tombstone trong `fetchCloudState()`: Truy vấn phải bao gồm cả sentinel `00000000-0000-0000-0000-000000000000` (được tạo khi `clearAllReadingHistory()`) để áp dụng anti-resurrection chuẩn xác.
     * Cấu trúc `finalization`:
       - `tombstonedStoryIds`: Danh sách `story_id` bị Cloud từ chối do có Tombstone xóa lịch sử (bao gồm cả trường hợp có global sentinel).
       - `finalizedReadingProgress`: Snapshot tiến độ đọc chính thức cho các truyện trong claim (đầy đủ 10 trường canonical).
       - `finalizedChapterReadStates`: Danh sách trạng thái đọc chính thức theo phạm vi claim (bắt buộc gồm `storyId`, `chapterId`, `maxProgressPercentage`, `completedAt`, `lastReadAt`).
   - **Quy tắc gộp dữ liệu theo từng Domain:**
     * `Bookmarks`: Additive merge (`INSERT OR IGNORE`), **TUYỆT ĐỐI KHÔNG** lọc bỏ theo reading history tombstone (xóa lịch sử đọc không làm mất bookmark).
     * `Reading History` & `Reading Progress`: Áp dụng nghiêm ngặt chính sách Anti-Resurrection dựa trên tombstone (story tombstone hoặc global sentinel).
     * `Finalized local state`: Reconcile/ghi đè chính xác các row liên quan trong `local_reading_progress` và `local_reading_history` theo snapshot authoritative của server, không chỉ `MAX` hoặc `INSERT OR IGNORE` lên cache cũ để triệt tiêu chênh lệch.
   - **Tái tạo Metadata cho `local_reading_history`:** Client ghép dữ liệu authoritative (`storyId`, `chapterId`, `maxProgressPercentage`, `lastReadAt`) với metadata truyện/chương đã có trong bản ghi SQLite của khách (`storyTitle`, `chapterNumber`, v.v.). Nếu thiếu metadata bắt buộc, client xử lý fail-closed, tuyệt đối không tạo placeholder rác.
   - **Dự phòng (Fallback Phương án B):** Nếu backend không trả `finalization`, client bảo toàn phân vùng nguồn của guest (không tự ý purge dữ liệu chưa thể tái tạo), vô hiệu hóa cache cục bộ của các truyện thuộc claim và fetch lại từ Cloud API.

3. **P0-3 — SQLite Recovery Journal Bền Vững (ACID Durability 9 Cột, 3 Observable Phases):**
   - Loại bỏ hoàn toàn `SharedPreferences` cho việc lưu trữ recovery context.
   - Bảng SQLite `guest_claim_recovery_journal` gồm **9 cột**: `claim_id`, `user_id`, `guest_profile_id`, `expected_state_fingerprint`, `conflict_decisions`, `phase`, `preview_data`, `created_at`, `updated_at`. Migration test v3 → v4 trên database có sẵn dữ liệu thực tế bảo toàn 100% dữ liệu cũ (bao gồm cả `offline_deletion_tombstones`).
   - Quản lý **3 observable phases**: `prepared`, `committing`, `committedServer`. Loại bỏ `rebindCompleted` vì bước xóa journal diễn ra cùng transaction với rebind.
   - Lưu trữ checkpoint bền vững trước khi mở BottomSheet (`prepared`) và trước khi gửi request `/commit` (`committing`).
   - `skipClaim(userId)` bị khóa cứng (throw `StateError`) khi claim đang ở phase `committing` hoặc `committedServer`.
   - Xử lý mã lỗi `409 Conflict`: Khi gặp 409 (cloud state thay đổi), client xác nhận chưa commit, hủy journal phiên cũ và thay thế bằng phiên prepare mới, reset lại các decisions.

4. **P0-4 — SQLite Schema Mapping Đầy Đủ 12 Cột & Integer Milliseconds:**
   - SQLite Rebind bảo toàn trọn vẹn 12 cột của bảng `local_reading_progress` (bao gồm `device_timestamp` và `updated_at` dưới dạng số nguyên milliseconds `INTEGER NOT NULL`).
   - Xung đột tiến độ đọc: Nếu user chọn `KEEP_CLOUD`, ngay cả khi SQLite chưa cache Cloud progress thì Mobile vẫn lấy `conflict.cloudProgress` từ server (chuyển đổi ISO string sang integer milliseconds) ghi vào `account:<userId>`.
   - Cả `INSERT OR REPLACE` (khi conflict) và `INSERT OR IGNORE` (khi non-conflict) đều cung cấp đủ 12 cột kèm `device_timestamp`.
   - Kiểm thử round-trip: Model `LocalReadingProgress` → Insert qua `rebindScope` → Query SQLite → `LocalReadingProgress.fromMap()` giải mã thành công không lỗi type cast hay rỗng trường.

5. **P0-5 — Tách Rời SQLite Local Library Transaction Khỏi Offline Filesystem Handover & Safe Ordering:**
   - SQLite Transaction chỉ áp dụng nguyên tử cho 3 bảng của Local Library: `local_library_bookmarks`, `local_reading_progress`, `local_reading_history` cùng bảng `guest_claim_recovery_journal`. Phân vùng file tải ngoại tuyến (`files/offline/<userScope>/...`) và bảng download (`offline_chapters`, `download_tasks`, `offline_deletion_tombstones`) được bảo toàn partition guest an toàn.
   - **Độc lập Interface giữa Task 3 và Task 4 (No Broken Interim State):** Task 3 định nghĩa interface `ScopeCoordinatorClaimBridge` (chứa `transitionGeneration` và `resolveToAccount`) qua Dependency Injection để có thể biên dịch và pass test 100% với fake adapter. Task 4 hoàn thiện việc nối dây thực tế vào `ActiveScopeCoordinator`. Không merge commit trung gian không biên dịch lên branch chính.
   - **Khả Năng Phục Hồi Mạng Cho AC-09 (`AuthService.initializeAuth`):** Sửa đổi `AuthService.initializeAuth()` để lỗi mạng tạm thời khi gọi `/auth/me` không tự động hạ cấp state về `unauthenticated` khi access/refresh token còn hiệu lực, bảo toàn recovery context cho đến khi kết nối mạng được phục hồi.

---

## 2. Chi Tiết Thiết Kế Từng Tầng Kỹ Thuật

### 2.1. Tầng Trạng Thái & Điều Phối Định Danh (Identity & Scope State Machine)

#### `ActiveScopeCoordinator` ([apps/mobile/lib/core/identity/active_scope_coordinator.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/identity/active_scope_coordinator.dart))
- Bổ sung quản lý thế hệ chuyển đổi (Generation Counter):
  ```dart
  int _transitionGeneration = 0;
  int get transitionGeneration => _transitionGeneration;
  ```
- Bổ sung phương thức explicit:
  * `void setTransitioning()`:
    - Tăng `_transitionGeneration++`.
    - Đưa trạng thái sang `ActiveScopeState.transitioning`, set `_activeScope = null`, `canMutateUserState = false`, phát sự kiện `notifyListeners()`.
  * `void resolveToAccount(String userId, {required int expectedGeneration})`:
    - **P0-1 Generation Invariant:** Nếu `expectedGeneration != _transitionGeneration`, lập tức drop callback! Không đổi state, không mở account (chống race condition từ claim cũ của user trước).
    - **Fail-Closed State Check:** Phải đang ở trạng thái `ActiveScopeState.transitioning` (ném `StateError` nếu gọi khi đang `guest` hoặc `bootstrapping`).
    - **Strict Validation:** `userId` sau khi trim không được rỗng. Nếu rỗng -> fallback fail-closed về `bootstrapping`.
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
      // Luôn chuyển sang TRANSITIONING, tăng generation, và khóa canMutateUserState = false.
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
  * **Cơ chế Báo Lỗi Có Thể Quan Sát (Observable Error & Fail-Closed):**
    - Loại bỏ việc nuốt lỗi âm thầm trong `_enqueueTransition`:
      ```dart
      Object? _lastTransitionError;
      StackTrace? _lastTransitionStackTrace;
      Object? get lastError => _lastTransitionError;

      Future<void> _enqueueTransition(AuthState state) {
        _currentTransition = _currentTransition.then((_) => _applyTransition(state)).catchError((e, s) {
          _lastTransitionError = e;
          _lastTransitionStackTrace = s;
          _logger.e('Lỗi chuyển đổi trạng thái AuthScopeBridge: $e', e, s);
          // Giữ coordinator ở trạng thái an toàn fail-closed (canMutateUserState = false)
        });
        return _currentTransition;
      }
      ```
  * Khi `onLogout()` xảy ra: coordinator lập tức set `TRANSITIONING` (generation tăng) -> xoay sang fresh `guestProfileId` -> chuyển sang `GUEST`. Mọi in-flight claim callback cũ của account bị vô hiệu hóa hoàn toàn.

#### Phân Định Rạch Ròi Bootstrap Readiness vs Scope Resolution (`bootstrap.dart`)
- **Chống Deadlock Khởi Động:**
  * `bootstrapReady`: Toàn bộ hạ tầng cốt lõi (Database, Preferences, API client, Auth, Router) đã sẵn sàng dựng Shell UI.
  * Khi app cold start có phiên đăng nhập hợp lệ: `AuthStatus.authenticated` đưa coordinator vào `ActiveScopeState.transitioning`.
  * `bootstrap.dart` **KHÔNG** await `waitForResolvedScope()` chặn việc tạo Router; Router và Shell được tạo ngay để render giao diện, và `GuestClaimCoordinator` tiếp nhận điều phối luồng claim hoặc crash recovery.

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
  committedServer,    // Phase 3: Server trả 200 COMMITTED -> Chuẩn bị thực hiện Atomic SQLite Rebind & Purge
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
   - Áp dụng authoritative snapshot từ `finalization` contract của server (hoặc fetch snapshot scoped `claimedStoryIds` nếu dùng fallback).
   - Xác minh toàn vẹn snapshot trong bộ nhớ thành công TRƯỚC KHI chạm vào dữ liệu SQLite.
5. **Atomic SQLite Transaction (Rebind + Purge + Journal Finalization):**
   - Thực thi MỘT transaction duy nhất:
     * Rebind bookmarks, progress (12 cột), history vào `account:<userId>`.
     * Purge sạch phân vùng `guest:<guestProfileId>`.
     * Xóa bản ghi trong `guest_claim_recovery_journal`.
6. **Mở Quyền Truy Cập (Single Authority):**
   - Gọi `resolveToAccount(userId, expectedGeneration: capturedGeneration)` để mở `canMutateUserState = true`.

#### Điều Kiện Ràng Buộc Trạng Thái Của `skipClaim()` (No Blind Skip)
- `skipClaim(userId)` **chỉ được phép thực hiện** khi claim đang ở trạng thái ban đầu (`prepared`).
- Khi claim đã bước vào `committing` (đã dispatch request commit lên server) hoặc `committedServer`, phương thức `skipClaim()` **bắt buộc ném `StateError`** và nút "Bỏ qua" trên UI bị disable. Ngăn chặn triệt để tình trạng server đã commit dữ liệu lên PostgreSQL nhưng client lại bấm Bỏ qua và xóa recovery journal.

#### Ma Trận Xử Lý Crash Recovery ([core/claim/guest_claim_coordinator.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/claim/guest_claim_coordinator.dart))
| Tình huống kiểm tra | Trạng thái máy chủ | Hành vi Mobile thực thi |
|---|---|---|
| `pending.userId != currentUserId` | Bất kỳ | Không can thiệp, bỏ qua claim của user khác, bảo vệ isolation |
| Generation mismatch / Stale | Bất kỳ | Drop stale callback, không thay đổi state, ghi log cảnh báo |
| Concurrency Triple-Check | Bất kỳ | Kiểm tra đồng thời: targetUserId, expectedGeneration, activeClaimId và actual AuthService user |
| Normal Crash Recovery | `COMMITTED` | Nhận authoritative finalization, chạy atomic SQLite rebind + purge + delete journal, gọi `resolveToAccount` |
| Normal Crash Recovery | `PREPARED` | Giữ scope `TRANSITIONING`, đọc preview data từ SQLite journal, mở lại `GuestClaimBottomSheet` kèm decisions |
| Normal Crash Recovery | `EXPIRED` hoặc `ABORTED` | Nếu SQLite khách vẫn còn dữ liệu: tạo phiên prepare mới; xóa journal cũ; không tự ý bỏ qua |
| Kiểm tra status mất mạng / offline | Lỗi mạng | Giữ nguyên scope `TRANSITIONING` (`PENDING_UNAVAILABLE`), cung cấp nút Thử lại |
| Lỗi mạng khi đang gửi `/commit` | Timeout / 5xx | Gọi `GET /status` kiểm tra xem commit đã vào DB server chưa trước khi quyết định retry hay rebind |
| Lỗi SQLite Rebind nội bộ | Exception | Rollback transaction tự động; SQLite journal giữ nguyên, cho phép thử lại an toàn |
| Crash sau SQLite commit nhưng trước `resolveToAccount` (AC-06) | Đã Rebind | Khi restart: Journal trống; thực hiện kiểm tra an toàn: guest partition đã purge và target account đã sẵn sàng trước khi gọi `resolveToAccount`, không suy luận mù quáng chỉ từ journal trống |
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
     GuestClaimFinalizationData? finalization,
   }) async {
     await _db.transaction((txn) async {
       // 1. Bookmarks: Additive merge (INSERT OR IGNORE) - TUYỆT ĐỐI KHÔNG loại bỏ theo reading tombstone
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

#### 2.3.1. Scoped Authoritative Cloud Reconciliation (Phương Án A & Fallback Phương Án B)
Loại bỏ hoàn toàn mọi cơ chế phỏng đoán heuristic:

1. **Phương Án A — Khuyến Nghị (Backend Authoritative Finalization Contract & PostgreSQL Persistence):**
   - Backend API (`POST /commit` và `GET /status`) trả về trường `finalization`:
     * `tombstonedStoryIds`: Danh sách các `story_id` bị Cloud từ chối vì có Tombstone (hoặc Global Sentinel).
     * `finalizedReadingProgress`: Snapshot tiến độ đọc chính thức cho các truyện trong claim (đầy đủ 10 trường canonical: storyId, chapterId, chapterVersionId, readingMode, pageIndex, scrollPosition, progressPercentage, anchorBlockId, textOffset, updatedAt).
     * `finalizedChapterReadStates`: Danh sách trạng thái đọc authoritative cho mọi chương thuộc phạm vi claim (bắt buộc gồm `storyId`, `chapterId`, `maxProgressPercentage`, `completedAt`, `lastReadAt`).
   - Phân biệt rõ rệt: `finalizedChapterReadStates` là snapshot authoritative cuối cùng cho toàn bộ các chapter trong claim scope (không chỉ riêng những dòng vừa thay đổi), bảo đảm Mobile biết rõ các giá trị Cloud đã tồn tại trước đó được giữ nguyên.
   - Client nhận snapshot này trực tiếp từ response commit / status check và chuyển vào `rebindScope`:
     * Ghi đè/reconcile chính xác các row liên quan trong `local_reading_progress` và `local_reading_history` theo snapshot authoritative, ngăn chặn tình trạng cache cũ cục bộ có giá trị sai cao hơn vẫn tồn tại nếu chỉ dùng phép `MAX` đơn thuần.
     * Đối với `local_reading_history`: Ghép các trường authoritative (`storyId`, `chapterId`, `maxProgressPercentage`, `lastReadAt`) với metadata chương/truyện từ bản ghi guest (`storyTitle`, `chapterNumber`, v.v.). Nếu thiếu dữ liệu bắt buộc -> fail-closed, không tạo placeholder rác.
   - **Lợi ích tuyệt đối:** Server là SSoT tính toán toàn bộ logic, Mobile chỉ áp dụng (Apply), triệt tiêu 100% rủi ro desynchronization giữa backend và mobile cache.

2. **Dự Phòng (Fallback Phương Án B):**
   - Nếu kết nối tới backend mock/legacy không trả trường `finalization`:
   - Mobile bảo toàn phân vùng nguồn `guest:<guestProfileId>` trong SQLite (tuyệt đối không tự ý purge dữ liệu chưa thể tái tạo xác thực).
   - Vô hiệu hóa (invalidate) cache cục bộ của các truyện thuộc `claimedStoryIds`, không import bất kỳ reading history hay reading progress nào của khách chưa được xác minh.
   - Chỉ merge bookmarks (`INSERT OR IGNORE`) và dựng lại tiến độ đọc khi người dùng mở truyện đọc qua các API chuẩn (`/library/reading-progress/:storyId`).

3. **Thực Thi Nguyên Tử Apply & Purge Trong Cùng SQLite Transaction:**
   - Dữ liệu authoritative được chuyển vào `rebindScope`.
   - Toàn bộ quá trình:
     * Ghi nhận bookmarks của khách vào tài khoản (`INSERT OR IGNORE`) — additive merge, không loại chỉ vì reading history tombstone.
     * Sáp nhập lịch sử theo authoritative `finalizedChapterReadStates` (loại trừ `tombstonedStoryIds`).
     * Ghi tiến độ đọc đủ 12 cột (integer milliseconds) theo authoritative `finalizedReadingProgress` (loại trừ `tombstonedStoryIds`).
     * **PURGE** sạch phân vùng nguồn `guest:<guestProfileId>` trong SQLite (chỉ khi có finalization hợp lệ).
     * Xóa bản ghi checkpoint trong `guest_claim_recovery_journal`.
   - Diễn ra nguyên tử trong **MỘT TRANSACTION SQLITE DUY NHẤT** (All-or-Nothing).
   - Nếu xảy ra sự cố mạng trước khi lấy xong response commit: Phân vùng khách và tài khoản hoàn toàn không bị thay đổi, journal giữ nguyên để retry an toàn.

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
   - Nút "Bỏ qua" (Skip) bị **disable** khi đang gửi commit (`isCommitting == true`) để bảo vệ tính toàn vẹn trạng thái.
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
| **AC-04** | Ứng dụng sập (Crash) ngay sau khi máy chủ trả `200 OK (COMMITTED)` | Khi khởi động lại, recovery đọc context từ SQLite journal, nhận authoritative finalization, thực hiện SQLite rebind idempotent và dọn partition nguồn thành công. |
| **AC-05** | Ứng dụng sập khi SQLite transaction đang chạy dở dang | SQLite transaction tự rollback toàn bộ, không có dữ liệu chắp vá; SQLite journal giữ nguyên để thử lại. |
| **AC-06** | Ứng dụng sập sau khi SQLite commit xong nhưng trước `resolveToAccount()` | Khi khởi động lại, recovery thấy journal trống và partition khách đã purge sạch sẽ, an toàn gọi `resolveToAccount(userId, generation)`. |
| **AC-07** | Người dùng chọn `KEEP_CLOUD` nhưng SQLite chưa từng cache progress của truyện đó | SQLite ghi đúng `conflict.cloudProgress` từ server (đầy đủ 12 cột, integer milliseconds) vào `account:<userId>`, không bị null hoặc ghi đè sai. |
| **AC-08** | Server từ chối tiến độ đọc vì truyện đã có Tombstone trên Cloud | Quá trình scoped reconciliation loại trừ `tombstonedStoryIds`, không tái sinh (resurrect) reading history hoặc progress của truyện đó vào `account:<userId>`. |
| **AC-09** | Gọi `/auth/me` gặp lỗi mạng tạm thời trong khi đang có recovery context | Không xem là logout, không rotate `guestProfileId`, giữ nguyên recovery context để khôi phục khi có mạng. |
| **AC-10** | Tài khoản A có pending claim, sau đó đăng xuất và đăng nhập Tài khoản B | Không áp dụng claim của Tài khoản A lên Tài khoản B. Generation guard hủy bỏ mọi stale callback cũ. Phân định rạch ròi theo `pending.userId`. |
| **AC-11** | Sự cố thao tác tệp ngoại tuyến (nếu có) | Không gây gián đoạn hoặc xóa hỏng các gói chương tải offline của guest. |
| **AC-12** | Người dùng chủ động chọn "Bỏ qua" (Skip) | Chỉ cho phép khi ở phase `prepared`. Thêm `guestProfileId` vào danh sách marker SharedPreferences, giữ nguyên 100% partition SQLite `guest:<guestProfileId>`, mở ACCOUNT. |

---

## 4. Kế Hoạch Triển Khai Tuần Tự (Dependency-Safe Phased Order)

Thứ tự triển khai được cấu trúc lại chặt chẽ theo hướng **Bottom-Up Layered Slice**, loại bỏ hoàn toàn tình trạng deadlock trung gian:

1. **Phase 1: Task 1 — Storage Schema & Recovery Models (Độc lập, sẵn sàng TDD RED)**
   - Triển khai schema SQLite v4 cho `guest_claim_recovery_journal` (9 cột).
   - Migration test v3 → v4 trên database có sẵn dữ liệu đầy đủ (bao gồm `offline_deletion_tombstones`).
   - Model `PendingGuestClaim` (3 observable phases: `prepared`, `committing`, `committedServer`).
   - Hardening DTOs: validate 64-char hex SHA-256 fingerprint, fail-closed `GuestClaimStatus`, 1-based `pageIndex`.

2. **Backend Prerequisite Gate: Backend Authoritative Finalization & Global Tombstone Fix (Bắt buộc trước Task 2/3)**
   - Shared Canonical Types (`packages/shared/src/types/claim.types.ts`):
     * `ClaimFinalizedProgressItem`, `ClaimFinalizedChapterReadStateItem`, `GuestClaimFinalizationData`.
     * Cập nhật `GuestClaimCommitResult` và `GuestClaimStatusResult`.
   - PostgreSQL Persistence: Bổ sung cột `finalization_data` JSONB vào `guest_claims` qua migration TypeORM.
   - Core API Service (`guest-claim.service.ts`):
     * Khắc phục Global Tombstone Sentinel: `fetchCloudState()` truy vấn cả `00000000-0000-0000-0000-000000000000`.
     * Áp dụng anti-resurrection khi có sentinel hoặc story tombstone.
     * Lưu `finalization_data` bền vững trong transaction `COMMITTED`.
     * `getClaimStatus` và `commitClaim` idempotent replay trả về `finalization` nhất quán.
     * Thêm backend regression tests: `clearAllReadingHistory() -> prepare -> commit`.
   - Dart Mirror: Cập nhật `guest_claim_models.dart`.

3. **Phase 2: Task 2 — SQLite DAO Rebind & Finalization Engine**
   - `LocalLibraryDao`: `hasGuestData` (fail-closed), `getClaimedStoryIds`.
   - `rebindScope`: mapping 12 cột cho `local_reading_progress` (integer milliseconds), hỗ trợ `finalization` snapshot (reconcile chính xác các row), bookmarks additive merge (`INSERT OR IGNORE`, không loại theo tombstone), atomic purge guest partition và delete journal row trong CÙNG MỘT transaction.
   - Tái tạo metadata cho `local_reading_history` từ bản ghi guest với fail-closed check.
   - Kiểm thử round-trip model → SQLite → model.

4. **Phase 3 & 4: Task 3 & Task 4 — Claim Engine & Identity Scope (Vertical Slice Integration)**
   - **Task 3: GuestClaimCoordinator Engine & Durable Recovery:**
     * State machine claim với SQLite journal 3-phase.
     * Sử dụng interface `ScopeCoordinatorClaimBridge` (DI) để biên dịch độc lập trước khi Task 4 hoàn thiện.
     * Concurrency Triple-Check guard (user, generation, claimId, actual AuthService user).
     * Guard `skipClaim` (chặn khi `committing` / `committedServer`), 409 re-prepare journal replacement.
     * Crash recovery matrix xử lý đầy đủ các kịch bản.
   - **Task 4: Identity Scope & Bootstrap Synchronization Gate:**
     * Nối dây thật vào `ActiveScopeCoordinator`: `setTransitioning()`, `resolveToAccount(userId, {required int expectedGeneration})`.
     * `onAuthStatusChanged(AuthStatus.authenticated)` luôn gọi `setTransitioning()`.
     * Cập nhật `AuthScopeBridge`: cơ chế báo lỗi có thể quan sát (`lastError`), không nuốt lỗi âm thầm.
     * Cập nhật `AuthService.initializeAuth()`: lỗi mạng tạm thời không hạ cấp về `unauthenticated` (AC-09).
     * Cập nhật `bootstrap.dart`: tách biệt `bootstrapReady` khỏi `scopeResolved`.
     * Cập nhật toàn bộ existing identity tests. Luồng Auth → Claim Coordinator → Bootstrap hoàn toàn thông suốt tại checkpoint này!

5. **Phase 5: Task 5 — Presentation & Root Shell Orchestration (`GuestClaimBottomSheet`)**
   - Xây dựng `GuestClaimBottomSheet` với `PopScope(canPop: false)`, disable Skip khi `isCommitting`, retry button.
   - Gắn `GuestClaimListener` tại Root Widget Shell.

6. **Phase 6: Task 6 — Comprehensive Acceptance Suite (12 Scenarios) & Full Regression**
   - 12 Cross-Layer Acceptance Scenarios (`guest_claim_acceptance_test.dart`).
   - Chạy full `flutter test` bảo đảm 410+ tests PASS 100%.
   - Gắn `GuestClaimListener` tại Root Widget Shell.
6. **Phase 6: Comprehensive Testing Suite & Regression Verification**
   - 12 Cross-Layer Acceptance Scenarios (`guest_claim_acceptance_test.dart`).
   - Chạy full `flutter test` bảo đảm 410+ tests PASS 100%.
