# 🚀 Task 7B.3 Mobile Client Integration Implementation Plan

> **Mã công việc:** Task 7B.3 (Mobile Client Integration)  
> **Trạng thái:** `READY FOR FROZEN SIGNOFF (4 P0 Blockers Resolved)`  
> **Chiến lược thực thi:** Subagent-Driven Execution (TDD: RED → GREEN → Review diff → Regression → Commit → Gate signoff cho từng Task độc lập).  
> **Căn cứ kỹ thuật:**
> - [plans/phase_07b_mobile_claim_design_spec.md](phase_07b_mobile_claim_design_spec.md) (Design Spec đã fix 4 P0 blockers)
> - [plans/ROADMAP.md](ROADMAP.md) (Task 7B.3 Web = FROZEN CLEAN at `9f74ea1`, Hosted CI Run #435 Green 7/7)
> - Baseline Mobile hiện tại: `410/410 tests PASS (100%)`.

---

## 1. Mục Tiêu & Ranh Giới Kỹ Thuật (Architecture & Boundaries)

Triển khai hoàn chỉnh luồng chuyển giao dữ liệu Khách sang Tài khoản (Guest-to-Account Claim) trên ứng dụng Flutter di động với 5 nguyên tắc bất biến đã được chuẩn hóa:
1. **Zero-Bypass Authority:** `ActiveScopeCoordinator.onAuthStatusChanged(AuthStatus.authenticated)` luôn chuyển `transitioning`. Chỉ `GuestClaimCoordinator` (thẩm quyền duy nhất) mới được phép gọi `resolveToAccount(userId)`.
2. **SQLite ACID Durability:** Thay thế hoàn toàn `SharedPreferences` bằng bảng SQLite `guest_claim_recovery_journal`.
3. **Scoped Authoritative Reconciliation:** Giới hạn đối soát Cloud đúng tập `claimedStoryIds`, xác minh snapshot trước, apply + purge guest trong cùng 1 SQLite transaction.
4. **SQLite Schema 12 Cột:** Ánh xạ đủ 12 cột cho `local_reading_progress`, bao gồm `device_timestamp` và `updated_at` dạng integer milliseconds (`INTEGER NOT NULL`).
5. **Offline Filesystem Quarantine:** SQLite transaction chỉ áp dụng cho 3 bảng thư viện + recovery journal; không di chuyển/xóa tệp ngoại tuyến.

---

## 2. Kế Hoạch 6 Task Chi Tiết (TDD Step-by-Step)

---

### Task 1: SQLite Durable Recovery Journal & Enhanced Contracts Hardening

**Mục tiêu:** Xây dựng bảng SQLite `guest_claim_recovery_journal`, model `PendingGuestClaim` (hỗ trợ `toMap`/`fromMap` SQLite, integer milliseconds timestamp), và hardening các contracts DTO (fail-closed status, validate fingerprint 64 hex, 1-based `pageIndex`).

**Files:**
- Create: `apps/mobile/lib/core/claim/models/pending_guest_claim.dart`
- Modify: `apps/mobile/lib/core/storage/offline_database.dart`
- Modify: `apps/mobile/lib/core/claim/models/guest_claim_models.dart`
- Create: `apps/mobile/test/core/claim/models/pending_guest_claim_test.dart`
- Modify: `apps/mobile/test/core/storage/offline_database_test.dart` (hoặc test tương ứng)

**Interfaces:**
- Produces: `PendingGuestClaim`, `ClaimRecoveryPhase`
- Consumes: `ConflictResolution`, `GuestClaimStatus` từ `guest_claim_models.dart`, `OfflineDatabase`

- [ ] **Step 1: Viết test cho `PendingGuestClaim` và contract hardening (RED)**
  Tạo `apps/mobile/test/core/claim/models/pending_guest_claim_test.dart`:
  - Test SQLite mapping: `toMap()` và `fromMap()` cho `PendingGuestClaim`, kiểm tra serialization `conflictDecisions` (JSON string Map), `created_at` và `updated_at` dưới dạng `int millisecondsSinceEpoch`.
  - Test `copyWith` cập nhật `phase`, `conflictDecisions`, `previewDataJson`, `updatedAt`.
  - Test validation fingerprint: Payload commit từ chối fingerprint rỗng, thiếu, hoặc không đúng 64 ký tự hex SHA-256 (`^[a-fA-F0-9]{64}$`).
  - Test fail-closed validation cho `GuestClaimStatus.fromString`: ném `ArgumentError` khi gặp status lạ, không bao giờ fallback âm thầm.
  - Test 1-based `pageIndex`: Chặn `pageIndex < 1`, tự chuẩn hóa `>= 1`.

- [ ] **Step 2: Viết test kiểm tra migration/bảng `guest_claim_recovery_journal` trong `OfflineDatabase` (RED)**
  - Mở database kiểm tra bảng `guest_claim_recovery_journal` tồn tại với đủ 8 cột: `claim_id`, `user_id`, `guest_profile_id`, `expected_state_fingerprint`, `conflict_decisions`, `phase`, `created_at`, `updated_at`.

- [ ] **Step 3: Chạy test và xác nhận thất bại (Red)**
  Lệnh: `flutter test test/core/claim/models/pending_guest_claim_test.dart`
  Kỳ vọng: Lỗi biên dịch vì chưa có file `pending_guest_claim.dart` và chưa tạo bảng SQLite journal.

- [ ] **Step 4: Triển khai mã nguồn Task 1 (GREEN)**
  - Tạo `apps/mobile/lib/core/claim/models/pending_guest_claim.dart`:
    * Enum `ClaimRecoveryPhase { prepared, committing, committedServer, rebindCompleted }`.
    * Class `PendingGuestClaim` với `toMap()`, `fromMap()`, `copyWith()`.
  - Cập nhật `apps/mobile/lib/core/storage/offline_database.dart`:
    * Thêm `CREATE TABLE IF NOT EXISTS guest_claim_recovery_journal` vào `_onCreate` và `_onUpgrade`.
  - Cập nhật `apps/mobile/lib/core/claim/models/guest_claim_models.dart`:
    * Thêm validation 64-char hex SHA-256 cho `CommitGuestClaimPayload`.
    * Thêm fail-closed parser cho `GuestClaimStatus.fromString`.

- [ ] **Step 5: Chạy test và xác nhận vượt qua (Green)**
  Lệnh: `flutter test test/core/claim/models/pending_guest_claim_test.dart`
  Kỳ vọng: Toàn bộ tests PASS 100%.

- [ ] **Step 6: Chạy kiểm thử hồi quy cục bộ (Regression Check)**
  Lệnh: `flutter test`
  Kỳ vọng: 410+ tests PASS, không có lỗi hồi quy.

- [ ] **Step 7: Commit mã nguồn Task 1**
  Lệnh: `git add apps/mobile/lib/core/claim/ apps/mobile/lib/core/storage/offline_database.dart apps/mobile/test/core/claim/ && git commit -m "feat(mobile): implement SQLite durable recovery journal and contract hardening"`

---

### Task 2: Identity Scope & Bridge Single Authority (Zero-Bypass Architecture)

**Mục tiêu:** Đóng hoàn toàn bypass trong `ActiveScopeCoordinator.onAuthStatusChanged`, đảm bảo `authenticated` LUÔN chuyển sang `ActiveScopeState.transitioning` (`setTransitioning()`). Khóa quyền mở `account:<userId>` duy nhất cho `GuestClaimCoordinator.resolveToAccount(userId)`. Bổ sung `transitionGeneration` counter trong `AuthScopeBridge` chống async race condition. Thêm `AuthService.register()` đồng bộ auto-login.

**Files:**
- Modify: `apps/mobile/lib/core/identity/active_scope_coordinator.dart`
- Modify: `apps/mobile/lib/core/identity/auth_scope_bridge.dart`
- Modify: `apps/mobile/lib/core/auth/auth_service.dart`
- Create: `apps/mobile/test/core/identity/active_scope_coordinator_claim_test.dart`
- Create: `apps/mobile/test/core/identity/auth_scope_bridge_claim_test.dart`

**Interfaces:**
- Produces: `ActiveScopeCoordinator.setTransitioning()`, `ActiveScopeCoordinator.resolveToAccount(String userId)`, `AuthService.register(...)`
- Consumes: `AuthStatus`, `AuthState`

- [ ] **Step 1: Viết test cho Zero-Bypass Authority và Generation Counter (RED)**
  Tạo `apps/mobile/test/core/identity/active_scope_coordinator_claim_test.dart` & `auth_scope_bridge_claim_test.dart`:
  - Test zero-bypass: Gọi `onAuthStatusChanged(AuthStatus.authenticated, userId: 'u1')` -> State BẮT BUỘC là `ActiveScopeState.transitioning`, `activeScope == null`, `canMutateUserState == false`. Cấm tuyệt đối tự động mở `account:u1`.
  - Test strict `resolveToAccount(userId)`:
    * Khi state đang `transitioning` và `userId` hợp lệ -> State chuyển `ActiveScopeState.account`, `activeScope == 'account:u1'`, `canMutateUserState == true`.
    * Khi state KHÔNG PHẢI `transitioning` (ví dụ `bootstrapping` hoặc `guest`) -> Fail-closed (ném `StateError` hoặc không đổi state).
    * Khi `userId` rỗng -> Fail-closed về `bootstrapping`.
  - Test generation counter: Bắt đầu async transition -> gọi `onLogout()` giữa chừng -> generation counter tăng -> callback cũ bị hủy bỏ hoàn toàn, không thể mở `account`.
  - Test `AuthService.register()`: Gửi `POST /auth/register`, lưu tokens, phát trạng thái `authenticated`.

- [ ] **Step 2: Chạy test và xác nhận thất bại (Red)**
  Lệnh: `flutter test test/core/identity/active_scope_coordinator_claim_test.dart test/core/identity/auth_scope_bridge_claim_test.dart`
  Kỳ vọng: FAIL vì `onAuthStatusChanged` hiện tại vẫn tự resolve account và chưa có `setTransitioning` / `resolveToAccount`.

- [ ] **Step 3: Triển khai mã nguồn Task 2 (GREEN)**
  - Trong `active_scope_coordinator.dart`:
    * Thêm `void setTransitioning()`: `_state = ActiveScopeState.transitioning; _activeScope = null; notifyListeners();`.
    * Thêm `void resolveToAccount(String userId)`:
      - Kiểm tra `_state == ActiveScopeState.transitioning` (ném `StateError` nếu sai).
      - Trim `userId`. Nếu rỗng -> `_state = ActiveScopeState.bootstrapping; _activeScope = null; notifyListeners(); return;`.
      - `_activeScope = 'account:$trimmed'; _state = ActiveScopeState.account; _flushWaiters(_activeScope!); notifyListeners();`.
    * Cập nhật `onAuthStatusChanged(AuthStatus status, {String? userId})`:
      - Nhánh `authenticated`: kiểm tra `userId` hợp lệ -> gọi `setTransitioning()`. KHÔNG có nhánh tự động resolve account!
  - Trong `auth_scope_bridge.dart`:
    * Bổ sung `int _transitionGeneration = 0`.
    * Khi `AuthStatus.authenticated`: gọi `_coordinator.onAuthStatusChanged(AuthStatus.authenticated, userId: nextUserId)`.
    * Khi `onLogout()`: `_transitionGeneration++`, gọi `_coordinator.onLogout()`.
  - Trong `auth_service.dart`:
    * Bổ sung phương thức `Future<void> register({required String username, required String email, required String password})`.

- [ ] **Step 4: Chạy test và xác nhận vượt qua (Green)**
  Lệnh: `flutter test test/core/identity/active_scope_coordinator_claim_test.dart test/core/identity/auth_scope_bridge_claim_test.dart`
  Kỳ vọng: Toàn bộ tests PASS 100%.

- [ ] **Step 5: Chạy regression tests toàn bộ Identity**
  Lệnh: `flutter test test/core/identity/`
  Kỳ vọng: Toàn bộ tests PASS 100%.

- [ ] **Step 6: Commit mã nguồn Task 2**
  Lệnh: `git add apps/mobile/lib/core/identity/ apps/mobile/lib/core/auth/ apps/mobile/test/core/identity/ && git commit -m "feat(mobile): enforce zero-bypass single authority and generation counter in ActiveScopeCoordinator"`

---

### Task 3: SQLite DAO Rebind (12 Cột) & Scoped Authoritative Reconcile

**Mục tiêu:** Cập nhật `LocalLibraryDao`: Thêm `hasGuestData(ownerScope)` (fail-closed), `getClaimedStoryIds(ownerScope)`, và `rebindScope(...)` đảm bảo schema mapping 12 cột cho `local_reading_progress` (đầy đủ `device_timestamp` và `updated_at` dạng integer milliseconds `INTEGER NOT NULL`), áp dụng Cloud Precedence, và thực hiện merge + purge guest partition + delete recovery journal checkpoint trong CÙNG MỘT SQLite transaction nguyên tử. Viết kiểm thử round-trip model → SQLite → model.

**Files:**
- Modify: `apps/mobile/lib/core/storage/local_library_dao.dart`
- Create: `apps/mobile/test/core/storage/local_library_dao_rebind_test.dart`

**Interfaces:**
- Produces: `LocalLibraryDao.hasGuestData`, `LocalLibraryDao.getClaimedStoryIds`, `LocalLibraryDao.rebindScope`
- Consumes: `LocalReadingProgress`, `LocalBookmark`, `LocalReadingHistory`, `ConflictResolution`, `ReadingProgressConflict`

- [ ] **Step 1: Viết test cho SQLite Rebind 12 Cột & Round-Trip (RED)**
  Tạo `apps/mobile/test/core/storage/local_library_dao_rebind_test.dart`:
  - Test `hasGuestData(guestScope)`: trả `true` khi có dữ liệu; trả `false` khi trống; rethrow exception fail-closed khi DB lỗi.
  - Test `getClaimedStoryIds(guestScope)`: trích xuất đúng tập hợp `story_id` phân biệt từ 3 bảng.
  - Test `rebindScope` 12 cột:
    * `local_reading_progress` mapping đầy đủ 12 cột, không bị lỗi `NOT NULL constraint failed` trên `device_timestamp` và `updated_at`.
    * Test round-trip: Model `LocalReadingProgress` → Insert qua `rebindScope` → Query lại bằng `getProgress()` → `LocalReadingProgress.fromMap()` giải mã thành công không lỗi type cast hay rỗng trường.
    * Monotonic MAX cho `local_reading_history`.
    * Primary Key collision an toàn cho `local_library_bookmarks` (`INSERT OR IGNORE`).
    * Conflict `KEEP_CLOUD` khi local target chưa cache: Lấy `conflict.cloudProgress` (chuyển đổi ISO string sang integer milliseconds) ghi đủ 12 cột vào targetScope.
    * Atomic Transaction & Purge: Partition khách bị xóa sạch và bản ghi recovery journal bị xóa TRONG CÙNG TRANSACTION; nếu có exception giữa chừng, toàn bộ transaction rollback, partition khách và journal được bảo toàn 100%.

- [ ] **Step 2: Chạy test và xác nhận thất bại (Red)**
  Lệnh: `flutter test test/core/storage/local_library_dao_rebind_test.dart`
  Kỳ vọng: FAIL vì chưa có `hasGuestData`, `getClaimedStoryIds`, `rebindScope`.

- [ ] **Step 3: Triển khai mã nguồn Task 3 (GREEN)**
  - Trong `local_library_dao.dart`:
    * Thêm `Future<bool> hasGuestData(String ownerScope)`.
    * Thêm `Future<Set<String>> getClaimedStoryIds(String ownerScope)`.
    * Thêm `Future<void> rebindScope({...})`:
      - Chạy trong `_db.transaction((txn) async { ... })`.
      - 1. Bookmarks: `INSERT OR IGNORE`.
      - 2. History: `INSERT INTO ... ON CONFLICT DO UPDATE SET progress_percentage = MAX(...)`.
      - 3. Reading progress conflicts: `INSERT OR REPLACE` với đầy đủ 12 cột:
        `owner_scope, story_id, chapter_id, chapter_version_id, reading_mode, progress_percentage, scroll_position, page_index, anchor_block_id, text_offset, updated_at, device_timestamp`.
        Chuyển đổi `updatedAt` từ ISO string sang integer milliseconds: `DateTime.tryParse(p.updatedAt ?? '')?.toUtc().millisecondsSinceEpoch ?? DateTime.now().toUtc().millisecondsSinceEpoch`.
        Gán `device_timestamp = updatedAtMs`.
      - 4. Reading progress non-conflicts: `INSERT OR IGNORE` với đầy đủ 12 cột lấy từ `sourceScope` bao gồm `device_timestamp`.
      - 5. Apply `authoritativeCloudProgress` (nếu có) đầy đủ 12 cột.
      - 6. Purge sạch 3 bảng của `sourceScope`.
      - 7. Xóa checkpoint tương ứng trong `guest_claim_recovery_journal`.

- [ ] **Step 4: Chạy test và xác nhận vượt qua (Green)**
  Lệnh: `flutter test test/core/storage/local_library_dao_rebind_test.dart`
  Kỳ vọng: Toàn bộ tests PASS 100%.

- [ ] **Step 5: Chạy regression tests toàn bộ Core Storage**
  Lệnh: `flutter test test/core/storage/`
  Kỳ vọng: Toàn bộ tests PASS 100%.

- [ ] **Step 6: Commit mã nguồn Task 3**
  Lệnh: `git add apps/mobile/lib/core/storage/local_library_dao.dart apps/mobile/test/core/storage/ && git commit -m "feat(mobile): implement 12-column SQLite rebindScope with cloud precedence and atomic purge"`

---

### Task 4: GuestClaimCoordinator Engine & Durable Crash Recovery

**Mục tiêu:** Xây dựng `GuestClaimCoordinator` kế thừa `ChangeNotifier`. Quản lý state machine claim, lưu trữ durable recovery context vào SQLite table `guest_claim_recovery_journal` trước khi mở UI và trước khi commit. Thực thi Scoped Authoritative Cloud Reconciliation cho đúng `claimedStoryIds`. Chỉ mở `ACCOUNT` sau khi SQLite transaction commit thành công. Xử lý ma trận crash recovery toàn diện.

**Files:**
- Create: `apps/mobile/lib/core/claim/guest_claim_coordinator.dart`
- Create: `apps/mobile/test/core/claim/guest_claim_coordinator_test.dart`

**Interfaces:**
- Produces: `GuestClaimCoordinator` (ChangeNotifier): `checkAndPrepareClaim`, `confirmClaim`, `skipClaim`, `checkCrashRecovery`
- Consumes: `LocalLibraryDao`, `ActiveScopeCoordinator`, `GuestProfileIdentityProvider`, `ApiClient`, `LibraryRepository`, `ReadingProgressRepository`, `OfflineDatabase`

- [ ] **Step 1: Viết test cho Coordinator State Machine và Durable Recovery (RED)**
  Tạo `apps/mobile/test/core/claim/guest_claim_coordinator_test.dart`:
  - Test `checkAndPrepareClaim`:
    * Không có dữ liệu khách -> Gọi ngay `resolveToAccount(userId)`, không mở modal.
    * Có dữ liệu khách -> Gọi API `/prepare`, **lập tức ghi `PendingGuestClaim(phase: prepared)` vào SQLite journal trước khi set `isOpen = true`**.
    * Lỗi API prepare hoặc SQLite query -> Giữ nguyên `TRANSITIONING`, không mở account (fail-closed).
  - Test `confirmClaim`:
    * Ghi `PendingGuestClaim(phase: committing, decisions)` vào SQLite journal TRƯỚC KHI gửi HTTP request `/commit`.
    * Server trả 200 COMMITTED -> Ghi phase `committedServer` vào journal -> Lấy authoritative cloud snapshot cho `claimedStoryIds` -> Gọi `dao.rebindScope(...)` (thực hiện rebind + purge + delete journal trong cùng transaction) -> Gọi `resolveToAccount(userId)`.
    * Xử lý 409 Conflict: Tự động re-prepare và làm mới preview, giữ `TRANSITIONING`.
  - Test `skipClaim`: Lưu marker quarantine vào SharedPreferences, xóa journal (nếu có), bảo toàn 100% partition SQLite của guest, gọi `resolveToAccount(userId)`.
  - Test Crash Recovery Ma trận:
    * `pending.userId != currentUserId`: Không can thiệp, bỏ qua claim của user khác.
    * Server `COMMITTED`: Tự động kéo authoritative snapshot, rebind, xóa journal, mở account.
    * Server `PREPARED`: Đọc preview data từ SQLite journal, mở lại dialog kèm decisions đã chọn.
    * Server lỗi mạng: Giữ nguyên `TRANSITIONING` (`PENDING_UNAVAILABLE`), nút Thử lại.

- [ ] **Step 2: Chạy test và xác nhận thất bại (Red)**
  Lệnh: `flutter test test/core/claim/guest_claim_coordinator_test.dart`
  Kỳ vọng: FAIL vì chưa có file `guest_claim_coordinator.dart`.

- [ ] **Step 3: Triển khai mã nguồn Task 4 (GREEN)**
  - Viết `apps/mobile/lib/core/claim/guest_claim_coordinator.dart`:
    * Quản lý trạng thái: `isOpen`, `isPreparing`, `isCommitting`, `previewData`, `error`, `currentUserId`.
    * Triển khai `checkAndPrepareClaim(userId)`.
    * Triển khai `confirmClaim(userId, conflictDecisions)`.
    * Triển khai `skipClaim(userId)`.
    * Triển khai `checkCrashRecovery(userId)`.
    * Đảm bảo tính bền vững ACID: Mọi checkpoint phase đều ghi qua SQLite journal `OfflineDatabase.database`.
    * Đảm bảo scoped reconciliation: Giới hạn đối soát theo `dao.getClaimedStoryIds(guestScope)`.

- [ ] **Step 4: Chạy test và xác nhận vượt qua (Green)**
  Lệnh: `flutter test test/core/claim/guest_claim_coordinator_test.dart`
  Kỳ vọng: Toàn bộ tests PASS 100%.

- [ ] **Step 5: Chạy regression tests toàn bộ Claim module**
  Lệnh: `flutter test test/core/claim/`
  Kỳ vọng: Toàn bộ tests PASS 100%.

- [ ] **Step 6: Commit mã nguồn Task 4**
  Lệnh: `git add apps/mobile/lib/core/claim/ apps/mobile/test/core/claim/ && git commit -m "feat(mobile): implement GuestClaimCoordinator with SQLite recovery journal and scoped reconciliation"`

---

### Task 5: Presentation & Root Shell Orchestration (`GuestClaimBottomSheet`)

**Mục tiêu:** Xây dựng giao diện `GuestClaimBottomSheet` với `PopScope(canPop: false)`, Radio chọn giải pháp conflict trực quan, thông báo lỗi mạng kèm nút Retry. Tách biệt `bootstrapReady` vs `scopeResolved` trong `app/bootstrap.dart`. Gắn `GuestClaimListener` tại Root Widget tree (`app.dart`).

**Files:**
- Create: `apps/mobile/lib/features/claim/presentation/guest_claim_bottom_sheet.dart`
- Create: `apps/mobile/lib/features/claim/presentation/guest_claim_listener.dart`
- Modify: `apps/mobile/lib/app/bootstrap.dart`
- Modify: `apps/mobile/lib/app/app.dart`
- Create: `apps/mobile/test/features/claim/guest_claim_bottom_sheet_test.dart`

**Interfaces:**
- Produces: `GuestClaimBottomSheet`, `GuestClaimListener`
- Consumes: `GuestClaimCoordinator`, `AppColors`

- [ ] **Step 1: Viết widget test cho `GuestClaimBottomSheet` và Root Listener (RED)**
  Tạo `apps/mobile/test/features/claim/guest_claim_bottom_sheet_test.dart`:
  - Test hiển thị số lượng bookmarks, history, progress từ preview.
  - Test hiển thị bảng so sánh conflict và Radio chọn `KEEP_CLOUD` vs `USE_GUEST`.
  - Test `PopScope(canPop: false)`: chặn Back button khi claim đang pending.
  - Test primary CTA "Gộp vào tài khoản" kích hoạt `confirmClaim` kèm loading state.
  - Test secondary CTA "Bỏ qua" kích hoạt `skipClaim`.
  - Test error banner và nút Retry khi có lỗi mạng.
  - Test `GuestClaimListener`: tự động hiển thị modal khi `coordinator.isOpen == true`.

- [ ] **Step 2: Chạy test và xác nhận thất bại (Red)**
  Lệnh: `flutter test test/features/claim/guest_claim_bottom_sheet_test.dart`
  Kỳ vọng: FAIL vì chưa có các widget.

- [ ] **Step 3: Triển khai mã nguồn Task 5 (GREEN)**
  - Viết `apps/mobile/lib/features/claim/presentation/guest_claim_bottom_sheet.dart`:
    * Material 3 BottomSheet, responsive layout.
    * Bọc trong `PopScope(canPop: false)`.
    * Conflict selector component.
  - Viết `apps/mobile/lib/features/claim/presentation/guest_claim_listener.dart`:
    * Lắng nghe `GuestClaimCoordinator` và gọi `showModalBottomSheet(isDismissible: false, enableDrag: false)`.
  - Cập nhật `apps/mobile/lib/app/bootstrap.dart`:
    * Tách biệt `bootstrapReady` khỏi `scopeResolved`. Không chờ `waitForResolvedScope()` khi đang có claim.
  - Cập nhật `apps/mobile/lib/app/app.dart`:
    * Bọc `GuestClaimListener` tại Root Shell.

- [ ] **Step 4: Chạy test và xác nhận vượt qua (Green)**
  Lệnh: `flutter test test/features/claim/guest_claim_bottom_sheet_test.dart`
  Kỳ vọng: Toàn bộ tests PASS 100%.

- [ ] **Step 5: Chạy regression tests toàn bộ Features Presentation**
  Lệnh: `flutter test test/features/claim/`
  Kỳ vọng: Toàn bộ tests PASS 100%.

- [ ] **Step 6: Commit mã nguồn Task 5**
  Lệnh: `git add apps/mobile/lib/features/claim/ apps/mobile/lib/app/ apps/mobile/test/features/claim/ && git commit -m "feat(mobile): implement GuestClaimBottomSheet with PopScope and root shell listener"`

---

### Task 6: Cross-Layer Acceptance Suite (12 Scenarios) & Full Regression

**Mục tiêu:** Xây dựng bộ test tích hợp chéo tầng xác thực đầy đủ 12 kịch bản chấp nhận (AC-01 đến AC-12), bao gồm cả 4 blocker P0. Chạy full regression test suite cho toàn bộ ứng dụng Mobile bảo đảm 410+ tests PASS 100%.

**Files:**
- Create: `apps/mobile/test/features/claim/guest_claim_acceptance_test.dart`

**Interfaces:**
- Kiểm thử tích hợp toàn diện: `ActiveScopeCoordinator`, `AuthScopeBridge`, `GuestClaimCoordinator`, `LocalLibraryDao`, `OfflineDatabase`, `GuestClaimBottomSheet`.

- [ ] **Step 1: Viết 12 kịch bản chấp nhận trong `guest_claim_acceptance_test.dart` (RED)**
  - AC-01: Login/Register thành công -> Scope giữ nguyên `TRANSITIONING`, `canMutateUserState == false`, không tự mở account.
  - AC-02: GoRouter chuyển hướng khỏi `/login` -> `GuestClaimBottomSheet` vẫn hiển thị ở Root Shell.
  - AC-03: Cold start có pending claim -> Bootstrap không bị deadlock chờ scope.
  - AC-04: Crash sau 200 COMMITTED -> Recovery đọc SQLite journal, rebind idempotent và dọn partition khách an toàn.
  - AC-05: Crash giữa SQLite transaction -> Rollback toàn bộ, SQLite journal giữ nguyên để thử lại.
  - AC-06: Crash sau SQLite commit nhưng trước khi xóa journal -> Rebind lại idempotent an toàn, xóa journal, mở ACCOUNT.
  - AC-07: `KEEP_CLOUD` khi local chưa cache -> Ghi đúng `conflict.cloudProgress` (12 cột, integer milliseconds) vào account.
  - AC-08: Server từ chối vì Tombstone -> Scoped reconciliation không tái sinh reading history/progress vào account cache.
  - AC-09: `/auth/me` lỗi mạng khi đang có recovery context -> Không xem là logout, không rotate guest profile.
  - AC-10: Account A có pending claim, sau đó login Account B -> Không merge chéo giữa hai tài khoản.
  - AC-11: Thao tác claim không làm rách nát hay xóa tệp ngoại tuyến của khách.
  - AC-12: User chọn Bỏ qua (Skip) -> Lưu marker quarantine vào SharedPreferences, giữ nguyên 100% partition SQLite của guest, mở ACCOUNT.

- [ ] **Step 2: Chạy test chấp nhận và xác nhận toàn bộ PASS (GREEN)**
  Lệnh: `flutter test test/features/claim/guest_claim_acceptance_test.dart`
  Kỳ vọng: 12/12 acceptance tests PASS.

- [ ] **Step 3: Chạy full regression test suite cho Mobile**
  Lệnh: `flutter test`
  Kỳ vọng: Toàn bộ 410+ tests PASS 100%, 0 failures, 0 regressions.

- [ ] **Step 4: Commit mã nguồn Task 6 và hoàn tất Task 7B.3 Mobile**
  Lệnh: `git add apps/mobile/test/features/claim/guest_claim_acceptance_test.dart && git commit -m "test(mobile): verify 12 cross-layer acceptance tests and 4 P0 invariants for mobile claim"`

---

## 3. Quy Trình Nghiệm Thu Từng Task (Subagent Execution Checkpoints)

Mỗi Task khi được giao cho Subagent thực thi BẮT BUỘC phải tuân thủ nghiêm ngặt chu trình:
1. **RED:** Viết tests trước, chạy test xác nhận thất bại với lý do rõ ràng.
2. **GREEN:** Viết mã nguồn tối thiểu để pass tests.
3. **Review Diff:** Kiểm tra diff cục bộ, bảo đảm không vi phạm YAGNI/KISS, không tự ý refactor ngoài phạm vi Task.
4. **Regression Check:** Chạy bộ test liên quan và `flutter test` bảo đảm baseline không bị phá vỡ.
5. **Commit:** Tạo git commit cục bộ với thông điệp chuẩn mực.
6. **Gate Signoff:** Báo cáo chi tiết kết quả cho User và chỉ chuyển sang Task tiếp theo khi Checkpoint được chấp thuận.
