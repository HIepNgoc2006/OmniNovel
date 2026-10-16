# 🚀 Task 7B.3 Mobile Client Integration Implementation Plan

> **Mã công việc:** Task 7B.3 (Mobile Client Integration)  
> **Trạng thái:** `FINAL AMENDMENT REVIEW — READY FOR FROZEN SIGNOFF`  
> **Chiến lược thực thi:** Subagent-Driven Execution (TDD: RED → GREEN → Review diff → Regression → Commit → Gate signoff cho từng Task độc lập).  
> **Căn cứ kỹ thuật:**
> - [plans/phase_07b_mobile_claim_design_spec.md](phase_07b_mobile_claim_design_spec.md) (Design Spec đã cập nhật đầy đủ 4 P0 blockers và review gate feedback)
> - [plans/ROADMAP.md](ROADMAP.md) (Task 7B.3 Web = FROZEN CLEAN at `9f74ea1`, Hosted CI Run #435 Green 7/7)
> - Baseline Mobile hiện tại: `410/410 tests PASS (100%)`.

---

## 1. Mục Tiêu & Ranh Giới Kỹ Thuật (Architecture & Boundaries)

Triển khai hoàn chỉnh luồng chuyển giao dữ liệu Khách sang Tài khoản (Guest-to-Account Claim) trên ứng dụng Flutter di động với 5 nguyên tắc bất biến đã được khóa:
1. **Zero-Bypass Single Authority & Concurrency Guard:** `ActiveScopeCoordinator.onAuthStatusChanged(AuthStatus.authenticated)` luôn chuyển sang `transitioning`. Chỉ `GuestClaimCoordinator` (thẩm quyền duy nhất) mới được phép gọi `resolveToAccount(userId, {required int expectedGeneration})`. Triple-check concurrency (user id, generation, claim id) bảo vệ tuyệt đối trước stale callbacks.
2. **SQLite ACID Durability (9 Cột, 3 Observable Phases):** Thay thế hoàn toàn `SharedPreferences` bằng bảng SQLite `guest_claim_recovery_journal` gồm 9 cột: `claim_id`, `user_id`, `guest_profile_id`, `expected_state_fingerprint`, `conflict_decisions`, `phase`, `preview_data`, `created_at`, `updated_at`. Migration test v3 → v4 trên database có sẵn dữ liệu đảm bảo 100% an toàn. 3 phase bền vững: `prepared`, `committing`, `committedServer`.
3. **Authoritative Cloud Reconciliation (Phương Án A — Backend Finalization Contract):** Server trả về snapshot chính thức `finalization` (`tombstonedStoryIds`, `appliedReadingProgress`, `appliedChapterReadStates`) trực tiếp trong response `POST /commit` và `GET /status`. Mobile áp dụng trực tiếp trong CÙNG MỘT transaction với merge và purge. Fallback Phương án B vô hiệu hóa cache cục bộ nếu thiếu metadata.
4. **SQLite Schema 12 Cột & Integer Milliseconds:** Ánh xạ đủ 12 cột cho `local_reading_progress`, bao gồm `device_timestamp` và `updated_at` dạng integer milliseconds (`INTEGER NOT NULL`). Kiểm thử round-trip model → SQLite → model.
5. **Thứ Tự Triển Khai Không Có Deadlock (Dependency-Safe Bottom-Up Slice):** Hạ tầng Storage & DAO (Task 1 & 2) → Claim Engine (Task 3) → Identity Scope & Bootstrap readiness (Task 4) → UI Presentation (Task 5) → Acceptance & Regression (Task 6). Không bao giờ có commit trung gian khiến ứng dụng bị treo tại `waitForResolvedScope()`.

---

## 2. Kế Hoạch 6 Task Chi Tiết (TDD Step-by-Step)

---

### Task 1: SQLite Storage Schema v4 & Recovery Models

**Mục tiêu:** Nâng cấp SQLite schema từ v3 lên v4 với bảng `guest_claim_recovery_journal` 9 cột, kiểm thử migration v3 → v4 trên database pre-populated giữ nguyên 100% dữ liệu cũ (bookmarks, history, progress, downloads), triển khai model `PendingGuestClaim` (3 observable phases: `prepared`, `committing`, `committedServer`), và hardening các DTO contracts (64-char hex SHA-256 fingerprint, fail-closed `GuestClaimStatus`, 1-based `pageIndex`).

**Files:**
- Create: `apps/mobile/lib/core/claim/models/pending_guest_claim.dart`
- Modify: `apps/mobile/lib/core/storage/offline_database.dart`
- Modify: `apps/mobile/lib/core/claim/models/guest_claim_models.dart`
- Create: `apps/mobile/test/core/claim/models/pending_guest_claim_test.dart`
- Create: `apps/mobile/test/core/storage/offline_database_migration_v4_test.dart`

**Interfaces:**
- Produces: `PendingGuestClaim`, `ClaimRecoveryPhase` (3 phases: `prepared`, `committing`, `committedServer`), schema v4 `guest_claim_recovery_journal`
- Consumes: `ConflictResolution`, `GuestClaimStatus` từ `guest_claim_models.dart`, `OfflineDatabase`

- [x] **Step 1: Viết test cho `PendingGuestClaim` và contract hardening (RED)**
  Tạo `apps/mobile/test/core/claim/models/pending_guest_claim_test.dart`:
  - Test SQLite mapping: `toMap()` và `fromMap()` cho `PendingGuestClaim`, kiểm tra serialization `conflictDecisions` (JSON string Map), `previewDataJson`, `created_at` và `updated_at` dưới dạng `int millisecondsSinceEpoch`.
  - Test `ClaimRecoveryPhase`: Chỉ chứa đúng 3 giá trị (`prepared`, `committing`, `committedServer`), không có `rebindCompleted`.
  - Test `copyWith` cập nhật `phase`, `conflictDecisions`, `previewDataJson`, `updatedAt`.
  - Test validation fingerprint: Payload commit từ chối fingerprint rỗng, thiếu, hoặc không đúng 64 ký tự hex SHA-256 (`^[a-fA-F0-9]{64}$`).
  - Test fail-closed validation cho `GuestClaimStatus.fromStrictString`: ném `ArgumentError` khi gặp status lạ, không bao giờ fallback âm thầm.
  - Test 1-based `pageIndex`: Chặn `pageIndex < 1`, tự chuẩn hóa `>= 1`.

- [x] **Step 2: Viết test kiểm tra migration v3 → v4 trong `OfflineDatabase` (RED)**
  Tạo `apps/mobile/test/core/storage/offline_database_migration_v4_test.dart`:
  - Tạo SQLite database v3 với các bảng hiện hữu (`local_library_bookmarks`, `local_reading_progress`, `local_reading_history`, `download_tasks`, `offline_chapters`, `offline_deletion_tombstones`).
  - Chèn dữ liệu mẫu vào cả 6 bảng v3.
  - Chạy `initialize()` nâng cấp lên v4:
    * Kiểm tra bảng `guest_claim_recovery_journal` tồn tại với đủ **9 cột**: `claim_id`, `user_id`, `guest_profile_id`, `expected_state_fingerprint`, `conflict_decisions`, `phase`, `preview_data`, `created_at`, `updated_at`.
    * Kiểm tra toàn bộ dữ liệu mẫu trong 6 bảng v3 cũ (bao gồm cả `offline_deletion_tombstones`) vẫn nguyên vẹn 100%, không bị mất hay lỗi dữ liệu.

- [x] **Step 3: Chạy test và xác nhận thất bại (Red)**
  Lệnh: `flutter test test/core/claim/models/pending_guest_claim_test.dart test/core/storage/offline_database_migration_v4_test.dart`
  Kỳ vọng: FAIL vì chưa có file `pending_guest_claim.dart` và chưa có migration schema v4 (Commit `3d4d255`).

- [x] **Step 4: Triển khai mã nguồn Task 1 (GREEN)**
  - Tạo `apps/mobile/lib/core/claim/models/pending_guest_claim.dart`:
    * Enum `ClaimRecoveryPhase { prepared, committing, committedServer }`.
    * Class `PendingGuestClaim` với `toMap()`, `fromMap()`, `copyWith()`.
  - Cập nhật `apps/mobile/lib/core/storage/offline_database.dart`:
    * Tăng `databaseVersion = 4`.
    * Bổ sung DDL bảng `guest_claim_recovery_journal` (9 cột) vào `_onCreate` và `_onUpgrade` cho migration từ version < 4.
  - Cập nhật `apps/mobile/lib/core/claim/models/guest_claim_models.dart`:
    * Thêm validation regex 64-char hex SHA-256 cho `CommitGuestClaimPayload.validated()`.
    * Thêm fail-closed parser cho `GuestClaimStatus.fromStrictString()` và áp dụng trực tiếp vào toàn bộ production deserializers (`GuestClaimPreviewResult.fromJson`, `GuestClaimCommitResult.fromJson`, `GuestClaimStatusResult.fromJson`).
    * Chuẩn hóa `pageIndex >= 1` (`GuestProgressItem.safePageIndex`).

- [x] **Step 5: Chạy test và xác nhận vượt qua (Green)**
  Lệnh: `flutter test test/core/claim/models/pending_guest_claim_test.dart test/core/storage/offline_database_migration_v4_test.dart`
  Kết quả: Toàn bộ tests PASS 100% (7/7 tests).

- [x] **Step 6: Chạy kiểm thử hồi quy cục bộ (Regression Check)**
  Lệnh: `flutter test`
  Kết quả: 417/417 tests PASS (100% Green), không có bất kỳ lỗi hồi quy nào.

- [x] **Step 7: Commit mã nguồn Task 1**
  Lệnh: `git add apps/mobile/lib/core/claim/models/pending_guest_claim.dart apps/mobile/lib/core/claim/models/guest_claim_models.dart apps/mobile/lib/core/storage/offline_database.dart apps/mobile/test/core/storage/offline_database_v3_migration_test.dart plans/task_07b_3_mobile_implementation_plan.md && git commit -m "feat(mobile): complete Task 1 GREEN with SQLite schema v4 recovery journal and fail-closed contract hardening"`

---

### Task 1.5: Backend Finalization Prerequisite Gate (Canonical Contracts, PostgreSQL Durability & Global Tombstone Fix)

**Mục tiêu:** Hoàn thiện hạ tầng Backend và Canonical Types trước khi Mobile Task 2/3 tích hợp. Cập nhật Shared TS contracts, DTOs backend, TypeORM migration bổ sung `finalization_data` JSONB vào bảng `guest_claims`, sửa triệt để lỗ hổng Global Tombstone Sentinel (`00000000-0000-0000-0000-000000000000`) trong `fetchCloudState()`, lưu snapshot `finalization` bền vững trong PostgreSQL tại transaction `COMMITTED`, cập nhật `GET /status` và retry commit trả về cùng một snapshot, viết regression tests backend và cập nhật Dart mirror model.

**Files:**
- Modify: `packages/shared/src/types/claim.types.ts`
- Modify: `services/api/src/modules/claims/entities/guest-claim.entity.ts`
- Create: `services/api/src/database/migrations/1700000000020-AddGuestClaimFinalizationData.ts`
- Modify: `services/api/src/modules/claims/dto/guest-claim-response.dto.ts`
- Modify: `services/api/src/modules/claims/guest-claim.service.ts`
- Modify: `services/api/test/app.e2e-spec.ts` (hoặc tạo test claim tombstone regression)
- Modify: `apps/mobile/lib/core/claim/models/guest_claim_models.dart`

**Interfaces:**
- Produces: `ClaimFinalizedProgressItem`, `ClaimFinalizedChapterReadStateItem` (kèm `storyId`), `GuestClaimFinalizationData`, `GuestClaimCommitResult.finalization`, `GuestClaimStatusResult.finalization`
- Consumes: PostgreSQL `guest_claims.finalization_data`, `reading_history_tombstones`

- [x] **Step 1: Cập nhật Canonical Shared TypeScript Contracts**
  Trong `packages/shared/src/types/claim.types.ts`:
  - Thêm `ClaimFinalizedProgressItem` (10 trường canonical progress).
  - Thêm `ClaimFinalizedChapterReadStateItem` (`storyId`, `chapterId`, `maxProgressPercentage`, `completedAt`, `lastReadAt`).
  - Thêm `GuestClaimFinalizationData` (`tombstonedStoryIds`, `finalizedReadingProgress`, `finalizedChapterReadStates`).
  - Thêm `finalization?: GuestClaimFinalizationData` vào `GuestClaimCommitResult` và `GuestClaimStatusResult`.
  - Built cleanly: `packages/shared/dist/` emitted without errors.

- [x] **Step 2: Cập nhật Backend DTOs & PostgreSQL Entity Migration**
  - Tạo migration TypeORM `1700000000020-AddGuestClaimFinalizationData.ts`:
    `ALTER TABLE guest_claims ADD COLUMN IF NOT EXISTS finalization_data JSONB;`
  - Cập nhật `GuestClaim` entity với `@Column({ name: 'finalization_data', type: 'jsonb', nullable: true }) finalizationData: any | null;`.
  - Cập nhật `GuestClaimCommitResponseDto` và `GuestClaimStatusResponseDto` trong NestJS.

- [x] **Step 3: Sửa Global Tombstone Gap & Lưu Bền Vững Finalization trong `GuestClaimService`**
  - Trong `fetchCloudState()`:
    Khi `storyIds.length > 0`, câu truy vấn tombstones BẮT BUỘC bao gồm cả sentinel toàn cục:
    `WHERE user_id = $1 AND (story_id = ANY($2) OR story_id = '00000000-0000-0000-0000-000000000000'::uuid)`
  - Trong logic anti-resurrection:
    `const hasGlobalTombstone = tombstoneSet.has('00000000-0000-0000-0000-000000000000');`
    Nếu `hasGlobalTombstone || tombstoneSet.has(h.storyId)`, áp dụng anti-resurrection loại bỏ history & progress. Bookmarks KHÔNG bị chặn.
  - Xây dựng `finalization_data`:
    * `tombstonedStoryIds`: Tập các storyId bị chặn bởi tombstone (hoặc toàn bộ claimed storyIds nếu có global sentinel).
    * `finalizedReadingProgress`: Snapshot tiến độ đọc mới nhất của các truyện trong claim.
    * `finalizedChapterReadStates`: Snapshot authoritative của mọi chapter thuộc phạm vi claim kèm `storyId` được join từ `story_editions`.
  - Lưu bền vững:
    Trong `UPDATE guest_claims SET status = 'COMMITTED'`, lưu đồng thời `finalization_data = $4`.
  - Idempotency & Status:
    Khi `status === 'COMMITTED'`, retry commit và `getClaimStatus` đọc `finalization_data` từ DB trả về cho client (an toàn fail-closed với legacy claim).

- [x] **Step 4: Viết Backend Regression Test (Anti-Resurrection & Durability)**
  - Cập nhật `services/api/src/modules/claims/test/guest-claim.service.spec.ts`:
    * Test prepare anti-resurrection khi có global sentinel UUID.
    * Test commit anti-resurrection khi có global sentinel UUID (bookmarks vẫn được lưu).
    * Test tính toán và lưu `finalization_data` trong cùng transaction với `COMMITTED`.
    * Test commit retry trả về đúng snapshot `finalization` đã lưu (idempotency).
    * Test `getClaimStatus` trả về `finalization`.
    * Test `getClaimStatus` fail-closed an toàn với legacy claim không có `finalization_data`.
  - Kết quả: 24/24 unit tests passed trong `guest-claim.service.spec.ts` + 6/6 tests passed trong `guest-claim.controller.spec.ts`.

- [x] **Step 5: Cập nhật Dart Mirror Model**
  - Trong `apps/mobile/lib/core/claim/models/guest_claim_models.dart`:
    Thêm `ClaimFinalizedProgressItem`, `ClaimFinalizedChapterReadStateItem`, `GuestClaimFinalizationData`.
    Cập nhật `GuestClaimCommitResult.fromJson` và `GuestClaimStatusResult.fromJson` để parse `finalization`.
  - Cập nhật unit test trong `pending_guest_claim_test.dart` xác minh deserialization và legacy null safety.
  - Kết quả: 7/7 unit tests passed trong `pending_guest_claim_test.dart`.

- [x] **Step 6: P1 Test Refinement & Full Regression Checks**
  - Cập nhật `offline_database_v3_migration_test.dart` kiểm tra chính xác `expect(currentVersion, 4)`.
  - Full Mobile regression: 418/418 tests PASS (100% Green).
  - Full Web regression: 50/50 test files, 657/657 tests PASS (100% Green).

---

### Task 2: SQLite DAO Rebind (12 Cột) & Authoritative Reconciliation

**Mục tiêu:** Cập nhật `LocalLibraryDao`: Thêm `hasGuestData(ownerScope)` (fail-closed), `getClaimedStoryIds(ownerScope)`, và `rebindScope(...)` đảm bảo schema mapping 12 cột cho `local_reading_progress` (đầy đủ `device_timestamp` và `updated_at` dạng integer milliseconds `INTEGER NOT NULL`), áp dụng Cloud Precedence và Authoritative Finalization Snapshot (Phương án A), thực hiện merge bookmarks (`INSERT OR IGNORE`) theo cơ chế additive (KHÔNG lọc theo reading tombstone), monotonic history merge theo authoritative snapshot (loại trừ `tombstonedStoryIds`), ghép metadata cho `local_reading_history` từ bản ghi guest với fail-closed check, purge guest partition và xóa recovery journal checkpoint trong CÙNG MỘT SQLite transaction nguyên tử. Viết kiểm thử round-trip model → SQLite → model.

**Files:**
- Modify: `apps/mobile/lib/core/storage/local_library_dao.dart`
- Create: `apps/mobile/test/core/storage/local_library_dao_rebind_test.dart`

**Interfaces:**
- Produces: `LocalLibraryDao.hasGuestData`, `LocalLibraryDao.getClaimedStoryIds`, `LocalLibraryDao.rebindScope`
- Consumes: `LocalReadingProgress`, `LocalBookmark`, `LocalReadingHistory`, `ConflictResolution`, `ReadingProgressConflict`, `ClaimFinalizedProgressItem`, `ClaimFinalizedChapterReadStateItem`, `GuestClaimFinalizationData`

- [x] **Step 1: Viết test cho SQLite Rebind 12 Cột, Authoritative Finalization & Round-Trip (RED)**
  Tạo `apps/mobile/test/core/storage/local_library_dao_rebind_test.dart`:
  - Test `hasGuestData(guestScope)`: trả `true` khi có dữ liệu; trả `false` khi trống; rethrow exception fail-closed khi DB lỗi.
  - Test `getClaimedStoryIds(guestScope)`: trích xuất đúng tập hợp `story_id` phân biệt từ 3 bảng của khách.
  - Test Bookmarks: Additive merge (`INSERT OR IGNORE`), không bị loại bỏ ngay cả khi story có trong `tombstonedStoryIds`.
  - Test `rebindScope` 12 cột:
    * `local_reading_progress` mapping đầy đủ 12 cột, không bị lỗi `NOT NULL constraint failed` trên `device_timestamp` và `updated_at`.
    * Test round-trip: Model `LocalReadingProgress` → Insert qua `rebindScope` → Query lại bằng `getProgress()` → `LocalReadingProgress.fromMap()` giải mã thành công không lỗi type cast hay rỗng trường.
    * Reconcile chính xác các row trong `local_reading_progress` và `local_reading_history` theo authoritative snapshot, ghi đè đúng giá trị server thay vì chỉ `MAX` đơn thuần.
    * Tái tạo metadata `local_reading_history`: Ghép đúng `storyTitle`, `chapterNumber` từ bản ghi guest; ném lỗi fail-closed nếu thiếu dữ liệu bắt buộc.
    * Conflict `KEEP_CLOUD` khi local target chưa cache: Lấy `conflict.cloudProgress` (chuyển đổi ISO string sang integer milliseconds) ghi đủ 12 cột vào targetScope.
    * Áp dụng authoritative finalization snapshot: Áp dụng `finalizedReadingProgress` và `finalizedChapterReadStates`, loại trừ các truyện trong `tombstonedStoryIds`.
    * Atomic Transaction & Purge: Partition khách bị xóa sạch và bản ghi recovery journal bị xóa TRONG CÙNG TRANSACTION; nếu có exception giữa chừng, toàn bộ transaction rollback, partition khách và journal được bảo toàn 100%.

- [x] **Step 2: Chạy test và xác nhận thất bại (Red)**
  Lệnh: `flutter test test/core/storage/local_library_dao_rebind_test.dart`
  Kết quả: FAIL như mong đợi (thiếu `hasGuestData`, `getClaimedStoryIds`, `rebindScope` trên `LocalLibraryDao`). Đã xác nhận trạng thái RED chuẩn xác.

- [x] **Step 3: Triển khai mã nguồn Task 2 (GREEN & Review Gate Hardening)**
  - Trong `local_library_dao.dart`:
    * Thêm `Future<bool> hasGuestData(String ownerScope)`.
    * Thêm `Future<Set<String>> getClaimedStoryIds(String ownerScope)`.
    * Thêm `Future<void> rebindScope({...})`:
      - Chạy trong `_db.transaction((txn) async { ... })`.
      - 1. Bookmarks: Additive merge `INSERT OR IGNORE` (KHÔNG lọc theo tombstone).
      - 2. Legacy fallback an toàn (Review Gate Amendment P0): Nếu `finalization == null`, chỉ rebind bookmarks additively và bảo toàn 100% mọi dữ liệu partition khách (bookmarks, progress, history) và recovery journal để coordinator quyết định; tuyệt đối không xóa bất kỳ bản ghi nào của khách.
      - 3. Negative cache reconciliation (Review Gate Amendment P1): Trong phạm vi các story có authoritative history snapshot, xóa sạch mọi chapter history cũ trong targetScope không còn tồn tại trong snapshot; bảo toàn 100% các story ngoài phạm vi claim.
      - 4. History: Pre-validate metadata từ source/target, ném `StateError` fail-closed nếu thiếu; Reconcile theo `finalizedChapterReadStates` (loại trừ `tombstonedStoryIds`).
      - 5. Reading progress: Reconcile theo `finalizedReadingProgress` với đầy đủ 12 cột NOT NULL (`device_timestamp`, `updated_at` chuẩn hóa).
      - 6. Purge sạch 3 bảng của `sourceScope`.
      - 7. Xóa checkpoint tương ứng trong `guest_claim_recovery_journal` với bảo vệ đối chiếu đa chiều (Review Gate Amendment P0): Ràng buộc chính xác `claim_id`, `user_id`, `guest_profile_id` và xác nhận phase hợp lệ (`committing`, `committedServer`) trước khi xóa; rollback transaction nếu context không khớp.

- [x] **Step 4: Chạy test và xác nhận vượt qua (Green)**
  - Lệnh: `flutter test test/core/storage/local_library_dao_rebind_test.dart`
  - Kết quả: Toàn bộ 10/10 tests PASS 100% (bao gồm round-trip 12 cột, authoritative override, anti-resurrection, atomic rollback, multi-dimensional security journal delete guard, legacy non-destructive fallback, negative cache reconciliation).

- [x] **Step 5: Chạy regression tests toàn bộ Core Storage & Mobile**
  - Lệnh: `flutter test test/core/storage/` -> 19/19 tests PASS 100%.
  - Lệnh: `flutter test` -> 428/428 tests PASS 100% (0 errors).

- [x] **Step 6: Commit mã nguồn Task 2 Hardening**
  - Lệnh: `git add apps/mobile/lib/core/storage/local_library_dao.dart apps/mobile/test/core/storage/local_library_dao_rebind_test.dart plans/task_07b_3_mobile_implementation_plan.md && git commit -m "fix(mobile): resolve Task 2 review gate conditions with non-destructive fallback, multi-field journal verification, and negative reconciliation"`

---

### Task 3: GuestClaimCoordinator Engine & Durable Crash Recovery

**Mục tiêu:** Xây dựng `GuestClaimCoordinator` kế thừa `ChangeNotifier`. Quản lý state machine claim với SQLite journal 3-phase (`prepared`, `committing`, `committedServer`). Sử dụng interface `ScopeCoordinatorClaimBridge` (Dependency Injection) để tách biệt phụ thuộc và biên dịch độc lập trước Task 4. Bảo vệ concurrency bằng **Triple-Check Concurrency Guard** (user id, generation, active claim id, actual AuthService user) chống stale callback từ tài khoản trước hoặc async request muộn. Khóa cứng `skipClaim(userId)` khi claim đã bước vào `committing` hoặc `committedServer`. Điều phối authoritative finalization snapshot (Phương án A) và fallback (Phương án B bảo toàn partition guest). Xử lý ma trận crash recovery toàn diện.

**Files:**
- Create: `apps/mobile/lib/core/claim/scope_coordinator_claim_bridge.dart`
- Create: `apps/mobile/lib/core/claim/guest_claim_coordinator.dart`
- Create: `apps/mobile/test/core/claim/guest_claim_coordinator_test.dart`

**Interfaces:**
- Produces: `ScopeCoordinatorClaimBridge` (abstract interface), `GuestClaimCoordinator` (ChangeNotifier): `checkAndPrepareClaim`, `confirmClaim`, `skipClaim`, `checkCrashRecovery`
- Consumes: `LocalLibraryDao`, `ScopeCoordinatorClaimBridge`, `GuestProfileIdentityProvider`, `ApiClient`, `OfflineDatabase`, `AuthService`

- [x] **Step 1: Viết test cho Coordinator State Machine, Concurrency Guard và Durable Recovery (RED)**
  Tạo `apps/mobile/test/core/claim/guest_claim_coordinator_test.dart`:
  - Test `checkAndPrepareClaim`:
    * Không có dữ liệu khách -> Gọi ngay `resolveToAccount(userId, expectedGeneration: gen)`, không mở modal.
    * Có dữ liệu khách -> Gọi API `/prepare`, **lập tức ghi `PendingGuestClaim(phase: prepared)` vào SQLite journal trước khi set `isOpen = true`**.
    * Lỗi API prepare hoặc SQLite query -> Giữ nguyên `TRANSITIONING`, không mở account (fail-closed).
  - Test Concurrency Guard (Stale Callback Prevention):
    * Prepare cho User A bắt đầu -> User logout (generation tăng) -> User B login -> Callback prepare cũ của A trả về: Bị hủy bỏ hoàn toàn, không thay đổi state của B, không gọi `resolveToAccount`.
  - Test `confirmClaim`:
    * Ghi `PendingGuestClaim(phase: committing, decisions)` vào SQLite journal TRƯỚC KHI gửi HTTP request `/commit`.
    * Server trả 200 COMMITTED -> Ghi phase `committedServer` vào journal -> Nhận authoritative `finalization` snapshot -> Gọi `dao.rebindScope(...)` (thực hiện rebind + purge + delete journal trong cùng transaction) -> Gọi `resolveToAccount(userId, expectedGeneration: gen)`.
    * Xử lý 409 Conflict: Tự động re-prepare và làm mới preview, giữ `TRANSITIONING`.
  - Test `skipClaim`:
    * Khi ở phase `prepared`: Lưu marker quarantine vào SharedPreferences, xóa journal, bảo toàn 100% partition SQLite của guest, gọi `resolveToAccount(userId, expectedGeneration: gen)`.
    * Khi ở phase `committing` hoặc `committedServer`: Ném `StateError('Cannot skip claim once commit has started')`.
  - Test Crash Recovery Ma trận:
    * `pending.userId != currentUserId`: Không can thiệp, bỏ qua claim của user khác.
    * Server `COMMITTED`: Tự động áp dụng authoritative finalization, rebind, xóa journal, mở account.
    * Server `PREPARED`: Đọc preview data từ SQLite journal, mở lại dialog kèm decisions đã chọn.
    * Server lỗi mạng: Giữ nguyên `TRANSITIONING` (`PENDING_UNAVAILABLE`), cung cấp nút Thử lại.

- [x] **Step 2: Chạy test và xác nhận thất bại (Red)**
  - Lệnh: `flutter test test/core/claim/guest_claim_coordinator_test.dart`
  - Kết quả: Thất bại với lỗi compilation error chuẩn TDD RED: `Error when reading 'lib/core/claim/guest_claim_coordinator.dart': The system cannot find the file specified`.
  Lệnh: `flutter test test/core/claim/guest_claim_coordinator_test.dart`
  Kỳ vọng: FAIL vì chưa có file `guest_claim_coordinator.dart`.

- [x] **Step 3: Triển khai mã nguồn Task 3 (GREEN)**
  - Viết `apps/mobile/lib/core/claim/guest_claim_coordinator.dart`:
    * Quản lý trạng thái: `isOpen`, `isPreparing`, `isCommitting`, `previewData`, `error`, `currentUserId`.
    * Triển khai Triple-Check guard: bắt giữ `capturedGeneration = _scopeCoordinator.transitionGeneration`, `capturedUserId = userId`, `capturedClaimId = activeClaimId`, kiểm tra `authService.state.isAuthenticated == true` và `authService.state.user?.id == capturedUserId`.
    * Triển khai `checkAndPrepareClaim(userId)`.
    * Triển khai `confirmClaim(userId, conflictDecisions)`.
    * Triển khai `skipClaim(userId)` có guard chặn khi `isCommitting` hoặc `committedServer`.
    * Triển khai `checkCrashRecovery(userId)`.
    * Ghi journal bền vững qua `OfflineDatabase.database` ở từng checkpoint 3-phase (`prepared`, `committing`, `committedServer`).

- [x] **Step 4: Chạy test và xác nhận vượt qua (Green)**
  - Lệnh: `flutter test test/core/claim/guest_claim_coordinator_test.dart`
  - Kết quả: Toàn bộ 19/19 tests PASS 100% (bao gồm 12 kịch bản RED gốc + 7 acceptance cases mở rộng theo Review Gate).

- [x] **Step 5: Chạy regression tests toàn bộ Claim module & Full Mobile suite**
  - Lệnh: `flutter test test/core/storage/ test/core/claim/` -> 53/53 tests PASS 100%.
  - Lệnh: `flutter test` -> 447/447 tests PASS 100% (0 errors).

- [x] **Step 6: Commit mã nguồn Task 3**
  - Lệnh: `git add apps/mobile/lib/core/ apps/mobile/test/core/ plans/task_07b_3_mobile_implementation_plan.md && git commit -m "feat(mobile): complete Task 3 GREEN with GuestClaimCoordinator, triple-check concurrency guard, and 3-phase journal recovery"`

---

### Task 4: Identity Scope & Bootstrap Synchronization Gate (Vertical Slice Integration)

**Mục tiêu:** Hoàn thiện `ActiveScopeCoordinator` với `transitionGeneration` counter, `setTransitioning()`, và `resolveToAccount(userId, {required int expectedGeneration})`. Đóng hoàn toàn bypass trong `onAuthStatusChanged(AuthStatus.authenticated)` (luôn set transitioning). Cập nhật `AuthScopeBridge` với cơ chế báo lỗi có thể quan sát (`lastError`), bàn giao quyền mở account cho `GuestClaimCoordinator`. Tách biệt `bootstrapReady` khỏi `scopeResolved` trong `app/bootstrap.dart` để cold start không bao giờ bị deadlock tại `waitForResolvedScope()`. Cập nhật toàn bộ existing identity tests (`active_scope_coordinator_test.dart`, `auth_scope_bridge_test.dart`) sang mô hình Zero-Bypass mới. Thêm `AuthService.register()`.

**Files:**
- Modify: `apps/mobile/lib/core/identity/active_scope_coordinator.dart`
- Modify: `apps/mobile/lib/core/identity/auth_scope_bridge.dart`
- Modify: `apps/mobile/lib/core/auth/auth_service.dart`
- Modify: `apps/mobile/lib/app/bootstrap.dart`
- Modify: `apps/mobile/test/core/identity/active_scope_coordinator_test.dart`
- Modify: `apps/mobile/test/core/identity/auth_scope_bridge_test.dart`
- Create: `apps/mobile/test/core/identity/active_scope_coordinator_claim_test.dart`

**Interfaces:**
- Produces: `ActiveScopeCoordinator.transitionGeneration`, `ActiveScopeCoordinator.setTransitioning()`, `ActiveScopeCoordinator.resolveToAccount(String userId, {required int expectedGeneration})`, `AuthScopeBridge.lastError`, `AuthService.register(...)`
- Consumes: `AuthStatus`, `AuthState`, `GuestClaimCoordinator`

- [x] **Step 1: Viết test cho Zero-Bypass, Generation Guard, Bridge Error Observability, AC-09 Network Resilience và Bootstrap (RED)**
  Tạo `active_scope_coordinator_claim_test.dart` và cập nhật các test trong `active_scope_coordinator_test.dart`, `auth_service_test.dart`:
  - Test zero-bypass: `onAuthStatusChanged(AuthStatus.authenticated, userId: 'u1')` -> State BẮT BUỘC là `ActiveScopeState.transitioning`, `activeScope == null`, `canMutateUserState == false`. Cấm tự động mở `account:u1`.
  - Test strict `resolveToAccount(userId, expectedGeneration: gen)`:
    * Khi state đang `transitioning` và `expectedGeneration == coordinator.transitionGeneration`: State chuyển `account`, `activeScope == 'account:u1'`, `canMutateUserState == true`.
    * Khi `expectedGeneration` không khớp (stale callback): Không thay đổi state, giữ nguyên `transitioning`.
    * Khi state không phải `transitioning`: Ném `StateError`.
    * Khi `userId` rỗng: Fallback về `bootstrapping`.
  - Test `AuthScopeBridge`: Báo lỗi chuyển trạng thái qua `lastError`, giữ fail-closed thay vì nuốt lỗi âm thầm.
  - Test AC-09: `AuthService.initializeAuth()` gặp lỗi mạng tạm thời khi gọi `/auth/me` nhưng có saved token: Không chuyển về `unauthenticated`, không xóa token, giữ nguyên phiên làm việc và recovery context.
  - Test Bootstrap Readiness: `bootstrap.dart` hoàn thành khởi tạo router và trả kết quả `bootstrapReady` ngay cả khi scope đang ở `transitioning`.

- [x] **Step 2: Chạy test và xác nhận thất bại (Red)**
  - Lệnh: `flutter test test/core/identity/active_scope_coordinator_claim_test.dart test/core/auth/auth_service_test.dart`
  - Kết quả: FAIL chính xác theo kỳ vọng TDD RED vì thiếu các phương thức và thuộc tính mới (`transitionGeneration`, `resolveToAccount`, `markPendingUnavailable`, `lastError`, `register`).

- [x] **Step 3: Triển khai mã nguồn Task 4 (GREEN)**
  - Trong `active_scope_coordinator.dart`:
    * Thêm `int _transitionGeneration = 0`.
    * Implements `ScopeCoordinatorClaimBridge`.
    * Thêm `void setTransitioning({String? forUserId})`: Tăng generation đơn điệu (chặn duplicate generation bump cho cùng một session), `_state = ActiveScopeState.transitioning; _activeScope = null; notifyListeners();`.
    * Thêm `void resolveToAccount(String userId, {required int expectedGeneration})`:
      - Kiểm tra `_state == ActiveScopeState.transitioning` (ném `StateError` nếu sai).
      - Kiểm tra `expectedGeneration == _transitionGeneration` (drop fail-closed nếu không khớp).
      - Trim `userId`. Nếu rỗng -> fallback về `bootstrapping; _activeScope = null; notifyListeners(); return;`.
      - User guard: Kiểm tra `_pendingUserId == null || _pendingUserId == trimmed`.
      - `_activeScope = 'account:$trimmed'; _state = ActiveScopeState.account; _flushWaiters(_activeScope!); notifyListeners();`.
    * Cập nhật `onAuthStatusChanged`: Nhánh `authenticated` luôn gọi `setTransitioning(forUserId: trimmed)`.
  - Trong `auth_scope_bridge.dart`:
    * Bổ sung `Object? _lastTransitionError` và `Object? get lastError => _lastTransitionError`.
    * Ghi nhận error trong `_enqueueTransition`, log error và giữ fail-closed.
    * Chặn gọi transition lặp lại cho cùng một phiên authenticated để bảo vệ generation counter.
  - Trong `auth_service.dart`:
    * Bổ sung `Future<void> register({required String username, required String email, required String password})`.
    * Sửa đổi `initializeAuth()`: Phân biệt lỗi mạng và lỗi xác thực 401/403. Chỉ chuyển sang `unauthenticated` khi có lỗi xác thực dứt khoát hoặc không có token. Nếu gặp lỗi mạng tạm thời, phục hồi offline user từ access token và duy trì phiên xác thực để bảo vệ AC-09.
  - Trong `app/bootstrap.dart`:
    * Tách biệt `bootstrapReady` khỏi `scopeResolved`. Không chờ `waitForResolvedScope()` chặn tạo Router, tránh deadlock khi cold start có token.
  - Vá kẽ hở P0 Amendment trong `GuestClaimCoordinator`:
    * Kiểm tra `isSessionValid` ngay từ đầu `_processCommitResult` trước khi cập nhật SQLite journal sang `committedServer` hoặc rebind.
    * Sửa điều kiện check claim ID: `expectedClaimId != null && expectedClaimId != _currentClaimId` bảo đảm từ chối khi `_currentClaimId` bị reset null hoặc switched.
    * Reset `_currentUserId = null;` khi claim hoàn tất hoặc bị bỏ qua.
    * Bổ sung Test 20 xác minh request A về muộn khi claim ID bị xóa/đổi bị từ chối ngay cả khi generation chưa đổi.

- [x] **Step 4: Chạy test và xác nhận vượt qua (Green)**
  - Lệnh: `flutter test test/core/identity/ test/core/auth/ test/app/ test/core/claim/`
  - Kết quả: Toàn bộ tests Identity, Auth, Bootstrap và Claim PASS 100%.

- [x] **Step 5: Chạy regression tests toàn bộ Identity và Bootstrap**
  - Lệnh: `flutter test`
  - Kết quả: 462/462 tests PASS (100% Green, 0 errors, 0 failures).

- [x] **Step 6: Commit mã nguồn Task 4**
  - Lệnh: `git add apps/mobile/lib/ apps/mobile/test/ plans/task_07b_3_mobile_implementation_plan.md && git commit -m "feat(mobile): complete Task 4 GREEN with zero-bypass scope coordination, generation guard, and bootstrap readiness"`

---

### Task 5: Presentation & Root Shell Orchestration (`GuestClaimBottomSheet`)

**Mục tiêu:** Xây dựng giao diện `GuestClaimBottomSheet` với `PopScope(canPop: false)`, Radio chọn giải pháp conflict trực quan, disable nút "Bỏ qua" khi `isCommitting == true`, thông báo lỗi mạng kèm nút Retry. Gắn `GuestClaimListener` tại Root Widget tree (`app.dart`).

**Files:**
- Create: `apps/mobile/lib/features/claim/presentation/guest_claim_bottom_sheet.dart`
- Create: `apps/mobile/lib/features/claim/presentation/guest_claim_listener.dart`
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
  - Test secondary CTA "Bỏ qua" kích hoạt `skipClaim` khi ở phase `prepared`.
  - Test nút "Bỏ qua" bị disable khi `isCommitting == true`.
  - Test error banner và nút Retry khi có lỗi mạng.
  - Test `GuestClaimListener`: tự động hiển thị modal khi `coordinator.isOpen == true`.

- [x] **Step 2: Chạy test và xác nhận thất bại (Red)**
  - Lệnh: `flutter test test/core/claim/guest_claim_coordinator_test.dart`
  - Kết quả: Thất bại với lỗi compilation error chuẩn TDD RED: `Error when reading 'lib/core/claim/guest_claim_coordinator.dart': The system cannot find the file specified`.
  Lệnh: `flutter test test/features/claim/guest_claim_bottom_sheet_test.dart`
  Kỳ vọng: FAIL vì chưa có các widget.

- [ ] **Step 3: Triển khai mã nguồn Task 5 (GREEN)**
  - Viết `apps/mobile/lib/features/claim/presentation/guest_claim_bottom_sheet.dart`:
    * Material 3 BottomSheet, responsive layout.
    * Bọc trong `PopScope(canPop: false)`.
    * Conflict selector component.
    * Nút "Bỏ qua" bị disable khi `coordinator.isCommitting == true`.
  - Viết `apps/mobile/lib/features/claim/presentation/guest_claim_listener.dart`:
    * Lắng nghe `GuestClaimCoordinator` và gọi `showModalBottomSheet(isDismissible: false, enableDrag: false)`.
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

**Mục tiêu:** Xây dựng bộ test tích hợp chéo tầng xác thực đầy đủ 12 kịch bản chấp nhận (AC-01 đến AC-12), bao gồm cả 4 blocker P0 và các invariant crash recovery chuẩn xác (AC-06: crash sau SQLite commit trước `resolveToAccount`). Chạy full regression test suite cho toàn bộ ứng dụng Mobile bảo đảm 410+ tests PASS 100%.

**Files:**
- Create: `apps/mobile/test/features/claim/guest_claim_acceptance_test.dart`

**Interfaces:**
- Kiểm thử tích hợp toàn diện: `ActiveScopeCoordinator`, `AuthScopeBridge`, `GuestClaimCoordinator`, `LocalLibraryDao`, `OfflineDatabase`, `GuestClaimBottomSheet`.

- [ ] **Step 1: Viết 12 kịch bản chấp nhận trong `guest_claim_acceptance_test.dart` (RED)**
  - AC-01: Login/Register thành công -> Scope giữ nguyên `TRANSITIONING`, `canMutateUserState == false`, không tự mở account.
  - AC-02: GoRouter chuyển hướng khỏi `/login` -> `GuestClaimBottomSheet` vẫn hiển thị ở Root Shell.
  - AC-03: Cold start có pending claim -> Bootstrap không bị deadlock chờ scope (`bootstrapReady`).
  - AC-04: Crash sau 200 COMMITTED -> Recovery đọc SQLite journal, nhận authoritative finalization, rebind idempotent và dọn partition khách an toàn.
  - AC-05: Crash giữa SQLite transaction -> Rollback toàn bộ, SQLite journal giữ nguyên để thử lại.
  - AC-06: Crash sau SQLite commit nhưng trước `resolveToAccount()` -> Khởi động lại: SQLite đã có dữ liệu account, journal trống, guest partition đã xóa -> an toàn gọi `resolveToAccount(userId, generation)`.
  - AC-07: `KEEP_CLOUD` khi local chưa cache -> Ghi đúng `conflict.cloudProgress` (12 cột, integer milliseconds) vào account.
  - AC-08: Server từ chối vì Tombstone -> Scoped reconciliation loại trừ `tombstonedStoryIds`, không tái sinh reading history/progress vào account cache.
  - AC-09: `/auth/me` lỗi mạng khi đang có recovery context -> Không xem là logout, không rotate guest profile.
  - AC-10: Account A có pending claim, sau đó login Account B -> Generation guard hủy stale callback cũ, không merge chéo giữa hai tài khoản.
  - AC-11: Thao tác claim không làm rách nát hay xóa tệp ngoại tuyến của khách.
  - AC-12: User chọn Bỏ qua (Skip) -> Chỉ cho phép khi ở phase `prepared`, lưu marker quarantine vào SharedPreferences, giữ nguyên 100% partition SQLite của guest, mở ACCOUNT.

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
