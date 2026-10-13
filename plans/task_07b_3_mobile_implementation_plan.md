# 🚀 Task 7B.3 Mobile Client Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triển khai hoàn chỉnh luồng chuyển giao dữ liệu Khách sang Tài khoản (Guest-to-Account Claim) trên ứng dụng Flutter di động với thẩm quyền mở scope duy nhất, context phục hồi bền vững nhiều pha (Durable Multi-Phase Recovery), sáp nhập SQLite nguyên tử tuân thủ Cloud Precedence & Anti-Resurrection, và điều phối giao diện từ Root Application Shell.

**Architecture:** Sử dụng kiến trúc `ChangeNotifier` / `Provider` phân tầng sạch: `ActiveScopeCoordinator` khóa cứng `TRANSITIONING` khi authenticated; `GuestClaimCoordinator` điều phối chuẩn bị claim, lưu `PendingGuestClaim` vào `SharedPreferences` trước khi hiện giao diện, thực thi `rebindScope` trên SQLite và Cloud Reconciliation trước khi mở `account:<userId>`; `GuestClaimBottomSheet` được kích hoạt từ Root Shell với `PopScope(canPop: false)`.

**Tech Stack:** Flutter 3.24+, Dart 3.5+, SQLite (`sqflite`), `shared_preferences`, `flutter_secure_storage`, `dio`, `go_router`, `mocktail`.

## Global Constraints
- Nền tảng kiến trúc: Kế thừa `ChangeNotifier`, không đưa `flutter_bloc` vào dependencies.
- Zero-Mutation Invariant: `canMutateUserState` chỉ được `true` khi scope giải quyết dứt khoát thành `GUEST` hoặc `ACCOUNT`.
- Single Authority: Chỉ `GuestClaimCoordinator` có quyền gọi `resolveToAccount(userId)`. `AuthScopeBridge` tuyệt đối không được tự ý mở account.
- Durable Recovery Timeline: `PendingGuestClaim` phải được lưu vào `SharedPreferences` ngay sau khi `/prepare` thành công trước khi mở BottomSheet, và cập nhật `conflictDecisions` trước khi gửi `/commit`.
- Cloud Precedence & Anti-Resurrection: Lựa chọn `KEEP_CLOUD` luôn ghi dữ liệu cloud vào SQLite (kể cả khi local chưa cache); truyện có tombstone trên server bị loại trừ khỏi account local cache.
- Local Storage Boundary: SQLite transaction chỉ áp dụng cho 3 bảng `local_library_bookmarks`, `local_reading_progress`, `local_reading_history`. Không di chuyển hoặc xóa tệp ngoại tuyến `files/offline/<userScope>/...`.
- 1-based `pageIndex`: DTO và SQLite resume tuple luôn lưu trữ `pageIndex >= 1`.
- Canonical Reading Mode: Enum chỉ gồm `'WEBTOON' | 'PAGED' | 'NOVEL'`.
- Skip Marker Quarantine: Người dùng bấm Skip chỉ ghi marker profileId vào `SharedPreferences`, bảo toàn 100% partition vật lý `guest:<guestProfileId>` trong SQLite.

---

### Task 1: Durable Recovery Model & Enhanced Contracts

**Files:**
- Create: `apps/mobile/lib/core/claim/models/pending_guest_claim.dart`
- Modify: `apps/mobile/lib/core/claim/models/guest_claim_models.dart`
- Test: `apps/mobile/test/core/claim/models/pending_guest_claim_test.dart`

**Interfaces:**
- Produces: `PendingGuestClaim`, `ClaimRecoveryPhase`
- Consumes: `ConflictResolution`, `GuestClaimStatus` từ `guest_claim_models.dart`

- [ ] **Step 1: Viết test cho `PendingGuestClaim` và contract hardening**
  Tạo file `apps/mobile/test/core/claim/models/pending_guest_claim_test.dart`:
  - Test serialization/deserialization JSON cho `PendingGuestClaim`.
  - Test `copyWith` cập nhật `phase` và `conflictDecisions`.
  - Test fail-closed validation cho `GuestClaimStatus.fromString` (ném ArgumentError hoặc trả về giá trị không an toàn khi gặp chuỗi rác).
  - Test validation fingerprint 64 ký tự hex.

- [ ] **Step 2: Chạy test và xác nhận test thất bại (Red)**
  Chạy: `flutter test test/core/claim/models/pending_guest_claim_test.dart`
  Kỳ vọng: Lỗi biên dịch vì chưa có file `pending_guest_claim.dart`.

- [ ] **Step 3: Triển khai `pending_guest_claim.dart` và cập nhật `guest_claim_models.dart`**
  - Định nghĩa enum `ClaimRecoveryPhase { prepared, committing, committedServer, rebindCompleted }`.
  - Định nghĩa class `PendingGuestClaim` với đầy đủ các trường `claimId`, `userId`, `guestProfileId`, `expectedStateFingerprint`, `conflictDecisions`, `phase`, `createdAt`.
  - Thêm phương thức `toJson()`, `fromJson()`, `copyWith()`.
  - Thêm validation logic vào `CommitGuestClaimPayload` để chặn fingerprint rỗng hoặc không đúng 64 ký tự hex SHA-256.

- [ ] **Step 4: Chạy test và xác nhận test vượt qua (Green)**
  Chạy: `flutter test test/core/claim/models/pending_guest_claim_test.dart`
  Kỳ vọng: Toàn bộ tests PASS.

- [ ] **Step 5: Commit mã nguồn Task 1**
  Lệnh: `git add apps/mobile/lib/core/claim/models/ apps/mobile/test/core/claim/models/ && git commit -m "feat(mobile): implement PendingGuestClaim durable model and contract hardening"`

---

### Task 2: Identity Scope & Bridge Single Authority với Generation Counter

**Files:**
- Modify: `apps/mobile/lib/core/identity/active_scope_coordinator.dart`
- Modify: `apps/mobile/lib/core/identity/auth_scope_bridge.dart`
- Modify: `apps/mobile/lib/core/auth/auth_service.dart`
- Test: `apps/mobile/test/core/identity/active_scope_coordinator_claim_test.dart`
- Test: `apps/mobile/test/core/identity/auth_scope_bridge_claim_test.dart`

**Interfaces:**
- Produces: `ActiveScopeCoordinator.setTransitioning()`, `ActiveScopeCoordinator.resolveToAccount(String userId)`, `AuthService.register(...)`
- Consumes: `AuthStatus`, `AuthState`

- [ ] **Step 1: Viết test cho transition protection và generation counter**
  Tạo `apps/mobile/test/core/identity/active_scope_coordinator_claim_test.dart` & `auth_scope_bridge_claim_test.dart`:
  - Test `setTransitioning()` khóa cứng `canMutateUserState = false` và `activeScope = null`.
  - Test `resolveToAccount(userId)` giải quyết đúng `account:<userId>` và mở `canMutateUserState = true`.
  - Test `onAuthStatusChanged(AuthStatus.authenticated, deferScopeResolution: true)` giữ nguyên trạng thái `TRANSITIONING`.
  - Test async race: Bắt đầu claim check, sau đó gọi `onLogout()` -> callback claim check cũ bị vô hiệu hóa bởi `generationId`, không thể mở `account`.

- [ ] **Step 2: Chạy test và xác nhận test thất bại (Red)**
  Chạy: `flutter test test/core/identity/active_scope_coordinator_claim_test.dart test/core/identity/auth_scope_bridge_claim_test.dart`
  Kỳ vọng: FAIL vì chưa có `setTransitioning` và generation counter.

- [ ] **Step 3: Triển khai mã nguồn điều phối định danh**
  - Trong `active_scope_coordinator.dart`:
    * Thêm `void setTransitioning()`: `_state = ActiveScopeState.transitioning`, `_activeScope = null`, `notifyListeners()`.
    * Thêm `void resolveToAccount(String userId)`: validate trim userId, `_state = ActiveScopeState.account`, `_activeScope = 'account:$trimmed'`, flush waiters, `notifyListeners()`.
    * Cập nhật `onAuthStatusChanged` hỗ trợ cờ `bool deferScopeResolution = false`.
  - Trong `auth_scope_bridge.dart`:
    * Thêm `int _transitionGeneration = 0`.
    * Khi `AuthStatus.authenticated`: luôn gọi `_coordinator.onAuthStatusChanged(AuthStatus.authenticated, userId: nextUserId, deferScopeResolution: true)`. Không bao giờ tự gọi `resolveToAccount`.
    * Khi `onLogout()`: tăng `_transitionGeneration++`, gọi `_coordinator.onLogout()`.
  - Trong `auth_service.dart`:
    * Thêm phương thức `Future<void> register({required String username, required String email, required String password})`: gửi `POST /auth/register`, lưu token, cập nhật trạng thái `authenticated`.

- [ ] **Step 4: Chạy test và xác nhận test vượt qua (Green)**
  Chạy: `flutter test test/core/identity/active_scope_coordinator_claim_test.dart test/core/identity/auth_scope_bridge_claim_test.dart`
  Kỳ vọng: PASS 100%.

- [ ] **Step 5: Commit mã nguồn Task 2**
  Lệnh: `git add apps/mobile/lib/core/identity/ apps/mobile/lib/core/auth/ apps/mobile/test/core/identity/ && git commit -m "feat(mobile): enforce single authority and generation counter for account scope resolution"`

---

### Task 3: SQLite DAO Rebind & Cloud Precedence Merge

**Files:**
- Modify: `apps/mobile/lib/core/storage/local_library_dao.dart`
- Test: `apps/mobile/test/core/storage/local_library_dao_rebind_test.dart`

**Interfaces:**
- Produces: `LocalLibraryDao.hasGuestData(String ownerScope) -> Future<bool>`, `LocalLibraryDao.getAllProgress(String ownerScope) -> Future<List<LocalReadingProgress>>`, `LocalLibraryDao.rebindScope(...) -> Future<void>`
- Consumes: `LocalReadingProgress`, `LocalBookmark`, `LocalReadingHistory`, `ConflictResolution`, `ReadingProgressConflict`

- [ ] **Step 1: Viết test cho SQLite Rebind và Cloud Precedence**
  Tạo `apps/mobile/test/core/storage/local_library_dao_rebind_test.dart`:
  - Test `hasGuestData(guestScope)`: trả `true` khi có bookmark/progress/history; trả `false` khi trống; rethrow fail-closed khi DB lỗi.
  - Test `rebindScope` atomic transaction:
    * Primary Key collision: Account và Guest cùng có bookmark cho story S1 -> `INSERT OR IGNORE` không crash, bookmark của account được giữ.
    * Monotonic History: Guest có progress 80%, Account đã có 50% -> sau rebind progress thành 80%.
    * Conflict `KEEP_CLOUD` khi Account SQLite chưa cache: Viết đúng `conflict.cloudProgress` vào partition account.
    * Conflict `USE_GUEST`: Ghi đè `conflict.guestProgress` vào partition account.
    * Dọn dẹp: Partition nguồn `guest:<id>` bị xóa sạch 100%.
    * Transaction rollback: Nếu có lỗi giữa chừng, partition khách và account giữ nguyên 100%.

- [ ] **Step 2: Chạy test và xác nhận test thất bại (Red)**
  Chạy: `flutter test test/core/storage/local_library_dao_rebind_test.dart`
  Kỳ vọng: FAIL vì chưa có `rebindScope` và `hasGuestData`.

- [ ] **Step 3: Triển khai mã nguồn trong `LocalLibraryDao`**
  - Thêm `Future<bool> hasGuestData(String ownerScope)`: đếm records từ 3 bảng, rethrow khi có lỗi.
  - Thêm `Future<List<LocalReadingProgress>> getAllProgress(String ownerScope)`: query toàn bộ progress của scope.
  - Thêm `Future<void> rebindScope(...)`:
    * Chạy trong `_db.transaction((txn) async { ... })`.
    * Rebind bookmarks bằng `INSERT OR IGNORE`.
    * Rebind history bằng `INSERT ... ON CONFLICT DO UPDATE SET progress_percentage = MAX(...)`.
    * Rebind progress hỗ trợ `previewConflicts` và `conflictDecisions` (Cloud Precedence).
    * Delete source scope records.

- [ ] **Step 4: Chạy test và xác nhận test vượt qua (Green)**
  Chạy: `flutter test test/core/storage/local_library_dao_rebind_test.dart`
  Kỳ vọng: PASS 100%.

- [ ] **Step 5: Commit mã nguồn Task 3**
  Lệnh: `git add apps/mobile/lib/core/storage/local_library_dao.dart apps/mobile/test/core/storage/ && git commit -m "feat(mobile): implement fail-closed hasGuestData and transactional rebind with cloud precedence"`

---

### Task 4: GuestClaimCoordinator Engine & Durable Crash Recovery

**Files:**
- Create: `apps/mobile/lib/core/claim/guest_claim_coordinator.dart`
- Test: `apps/mobile/test/core/claim/guest_claim_coordinator_test.dart`

**Interfaces:**
- Produces: `GuestClaimCoordinator` (ChangeNotifier): `checkAndPrepareClaim`, `confirmClaim`, `skipClaim`, `checkCrashRecovery`
- Consumes: `LocalLibraryDao`, `ActiveScopeCoordinator`, `GuestProfileIdentityProvider`, `ApiClient`, `LibraryRepository`, `ReadingProgressRepository`

- [ ] **Step 1: Viết test cho Coordinator State Machine và Crash Recovery**
  Tạo `apps/mobile/test/core/claim/guest_claim_coordinator_test.dart`:
  - Test `checkAndPrepareClaim`: Không có guest data -> gọi `resolveToAccount(userId)`, không mở dialog.
  - Test `checkAndPrepareClaim`: Có guest data -> gọi prepare API, **lập tức lưu `PendingGuestClaim(phase: prepared)` vào SharedPreferences trước khi set `isOpen = true`**.
  - Test fail-closed: Khi prepare API lỗi hoặc SQLite query lỗi -> giữ nguyên `TRANSITIONING`, không mở account.
  - Test `confirmClaim`: Lưu decisions với `phase: committing` vào disk trước khi gửi `POST /commit`.
  - Test `confirmClaim`: Server trả 200 OK -> phase `committedServer` -> gọi DAO rebind và Cloud reconciliation -> phase `rebindCompleted` -> purge guest partition -> xóa context -> `resolveToAccount`.
  - Test `confirmClaim` 409 Conflict: Tự động re-prepare và làm mới preview, giữ `TRANSITIONING`.
  - Test `skipClaim`: Lưu marker `quarantineGuestScope`, xóa context, giữ nguyên SQLite partition, gọi `resolveToAccount`.
  - Test Crash Recovery:
    * `pending.userId != currentUserId`: Bỏ qua, không merge.
    * Server `COMMITTED`: Tự động rebind, xóa context, mở account.
    * Server `PREPARED`: Mở lại dialog kèm decisions.
    * Server lỗi mạng: Giữ `TRANSITIONING` (`PENDING_UNAVAILABLE`).

- [ ] **Step 2: Chạy test và xác nhận test thất bại (Red)**
  Chạy: `flutter test test/core/claim/guest_claim_coordinator_test.dart`
  Kỳ vọng: FAIL vì chưa có file `guest_claim_coordinator.dart`.

- [ ] **Step 3: Triển khai `GuestClaimCoordinator`**
  - Quản lý state kế thừa `ChangeNotifier`: `isOpen`, `isPreparing`, `isCommitting`, `previewData`, `error`, `currentUserId`.
  - Triển khai `checkAndPrepareClaim(userId)`:
    * Quét `hasGuestData`. Nếu false -> `resolveToAccount`.
    * Nếu true -> `setTransitioning()`.
    * Lấy bookmarks, history, progress từ DAO. Format 1-based `pageIndex >= 1` và canonical `ReadingMode`.
    * Gọi prepare API.
    * Lưu `PendingGuestClaim` vào SharedPreferences.
    * Đặt `isOpen = true`, `notifyListeners()`.
  - Triển khai `confirmClaim(userId, conflictDecisions)`:
    * Validate 64-char fingerprint.
    * Cập nhật `PendingGuestClaim(phase: committing, conflictDecisions: decisions)` vào SharedPreferences.
    * Gửi commit API.
    * Nếu 409 -> tự động re-prepare.
    * Nếu 200 -> cập nhật phase `committedServer` -> gọi `dao.rebindScope(...)` -> gọi `reconcileAccountLibraryState` -> cập nhật phase `rebindCompleted` -> xóa recovery context -> `resolveToAccount`.
  - Triển khai `skipClaim(userId)`: marker quarantine -> clear pending -> `resolveToAccount`.
  - Triển khai `checkCrashRecovery(userId)`.

- [ ] **Step 4: Chạy test và xác nhận test vượt qua (Green)**
  Chạy: `flutter test test/core/claim/guest_claim_coordinator_test.dart`
  Kỳ vọng: PASS 100%.

- [ ] **Step 5: Commit mã nguồn Task 4**
  Lệnh: `git add apps/mobile/lib/core/claim/ apps/mobile/test/core/claim/ && git commit -m "feat(mobile): implement GuestClaimCoordinator with durable multi-phase recovery and anti-resurrection"`

---

### Task 5: Presentation & Root Shell Orchestration (`GuestClaimBottomSheet`)

**Files:**
- Create: `apps/mobile/lib/features/claim/presentation/guest_claim_bottom_sheet.dart`
- Create: `apps/mobile/lib/features/claim/presentation/guest_claim_listener.dart`
- Modify: `apps/mobile/lib/app/bootstrap.dart`
- Modify: `apps/mobile/lib/app/app.dart`
- Test: `apps/mobile/test/features/claim/guest_claim_bottom_sheet_test.dart`

**Interfaces:**
- Produces: `GuestClaimBottomSheet`, `GuestClaimListener`
- Consumes: `GuestClaimCoordinator`, `AppColors`

- [ ] **Step 1: Viết widget test cho `GuestClaimBottomSheet`**
  Tạo `apps/mobile/test/features/claim/guest_claim_bottom_sheet_test.dart`:
  - Test hiển thị đúng số lượng preview (Bookmarks, Lịch sử, Tiến độ).
  - Test hiển thị khu vực Conflict: Radio chọn `KEEP_CLOUD` vs `USE_GUEST`.
  - Test `PopScope(canPop: false)`: chặn Back navigation khi claim đang pending.
  - Test nút "Gộp vào tài khoản" kích hoạt callback `confirmClaim`.
  - Test nút "Bỏ qua" kích hoạt callback `skipClaim`.
  - Test hiển thị lỗi mạng kèm nút "Thử lại (Retry)".

- [ ] **Step 2: Chạy test và xác nhận test thất bại (Red)**
  Chạy: `flutter test test/features/claim/guest_claim_bottom_sheet_test.dart`
  Kỳ vọng: FAIL vì chưa có file widget.

- [ ] **Step 3: Triển khai widget và tích hợp tầng Shell**
  - Viết `GuestClaimBottomSheet`:
    * Dùng Material 3 BottomSheet với `AppColors`.
    * Bọc toàn bộ widget trong `PopScope(canPop: false)`.
    * Hiển thị thống kê và bảng so sánh trực quan cho conflict.
    * Action buttons: Primary CTA "Gộp vào tài khoản" (loading state khi `isCommitting`), Secondary CTA "Bỏ qua".
    * Error banner với nút Retry khi `error != null`.
  - Viết `GuestClaimListener`:
    * Lắng nghe `GuestClaimCoordinator.isOpen`: khi `true`, tự động gọi `showModalBottomSheet(isDismissible: false, enableDrag: false)`.
  - Cập nhật `bootstrap.dart`:
    * Tách biệt `bootstrapReady` khỏi `scopeResolved`.
    * Đăng ký `GuestClaimCoordinator` vào `BootstrapResult`.
  - Cập nhật `app.dart`:
    * Bọc `GuestClaimListener` tại Root Widget tree của ứng dụng.

- [ ] **Step 4: Chạy test và xác nhận test vượt qua (Green)**
  Chạy: `flutter test test/features/claim/guest_claim_bottom_sheet_test.dart`
  Kỳ vọng: PASS 100%.

- [ ] **Step 5: Commit mã nguồn Task 5**
  Lệnh: `git add apps/mobile/lib/features/claim/ apps/mobile/lib/app/ apps/mobile/test/features/claim/ && git commit -m "feat(mobile): implement GuestClaimBottomSheet with PopScope and root shell listener"`

---

### Task 6: Cross-Layer Acceptance & Full Regression Suite

**Files:**
- Create: `apps/mobile/test/features/claim/guest_claim_acceptance_test.dart`

**Interfaces:**
- Kiểm thử tích hợp toàn diện 12 kịch bản chấp nhận (AC-01 đến AC-12)

- [ ] **Step 1: Viết 12 kịch bản chấp nhận trong `guest_claim_acceptance_test.dart`**
  - AC-01: Auth thành công -> scope giữ nguyên `TRANSITIONING`, mutation bị chặn.
  - AC-02: GoRouter redirect khỏi `/login` -> BottomSheet vẫn hiển thị ở Root Shell.
  - AC-03: Cold start có pending claim -> bootstrap không deadlock.
  - AC-04: Crash sau HTTP 200 COMMITTED -> recovery tự động rebind và dọn partition.
  - AC-05: Crash giữa SQLite transaction -> rollback toàn bộ, recovery context giữ nguyên.
  - AC-06: Crash sau SQLite commit trước khi xóa pending -> rebind lại idempotent an toàn.
  - AC-07: `KEEP_CLOUD` khi local chưa cache -> ghi đúng cloudProgress vào account.
  - AC-08: Server từ chối vì Tombstone -> không tái sinh local reading history/progress.
  - AC-09: `/auth/me` lỗi mạng khi có recovery context -> không coi là logout, không rotate profile.
  - AC-10: Account A có pending, sau đó login Account B -> không merge chéo.
  - AC-11: Tệp ngoại tuyến không bị xóa hoặc làm hỏng.
  - AC-12: User bấm Skip -> marker lưu SharedPreferences, partition SQLite giữ nguyên 100%.

- [ ] **Step 2: Chạy test chấp nhận và xác nhận toàn bộ PASS**
  Chạy: `flutter test test/features/claim/guest_claim_acceptance_test.dart`
  Kỳ vọng: 12/12 acceptance tests PASS.

- [ ] **Step 3: Chạy full regression test suite cho Mobile**
  Chạy: `flutter test`
  Kỳ vọng: Toàn bộ 410+ tests PASS 100%, 0 regression errors.

- [ ] **Step 4: Commit và hoàn tất Task 7B.3 Mobile**
  Lệnh: `git add apps/mobile/test/features/claim/guest_claim_acceptance_test.dart && git commit -m "test(mobile): verify 12 cross-layer acceptance tests for guest claim integration"`
