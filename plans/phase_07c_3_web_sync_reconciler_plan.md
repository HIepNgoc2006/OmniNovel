# 📋 Kế Hoạch Triển Khai Task 7C.3 — Web Client Sync Reconciler (`apps/web`)

> **Trạng thái:** `[/] Đang Triển Khai (PHASE 5.1 FROZEN CLEAN — STORAGE REVISION 2.2 APPROVED — STEP 5.2a & 5.2b FROZEN CLEAN — SECURITY REMEDIATION PR #210 MERGED & VERIFIED ON MAIN — STEP 5.2c IMPLEMENTED — PENDING FINAL GATE REVIEW)`  
> **Cơ sở pháp lý / Baseline nghiệm thu:** Task 7C.2 FROZEN CLEAN tại baseline `4e9c4dbfb96a6b7957090d8a306485333014c550` (Hosted CI Run #40701295336); Step 5.2b FROZEN CLEAN tại baseline `4a78f9c10f1ee0d891ba30cbeaaebe38343eac5f` (Hosted CI Run #42053644100 — 7/7 PASS); Security Remediation Only (PR `#210`) APPROVED & MERGED tại baseline `457576033e38e6fe3bbe1aa25351c917404d6c37` (Hosted CI Run `#42571464548` — 7/7 PASS). Step 5.2c giữ nguyên trạng thái **`IMPLEMENTED — PENDING FINAL GATE REVIEW`**.  
> **Phạm vi:** Trực thuộc **Phase 7C: Unified Multi-Device Sync Engine**. Triển khai bộ đồng bộ Client-Side trên ứng dụng Web Next.js 16 / React 19.

---

## 1. Mục Tiêu & Các Bất Biến Bắt Buộc (Strict Invariants)

Task 7C.3 triển khai trọn vẹn tầng Client-side Sync Engine trên Web (`apps/web`), đồng bộ hai chiều (Bi-directional Sync) với Core API Sync Hub thông qua giao thức Delta Revisions và Safe Snapshot Triage.

### 9 Bất Biến Kỹ Thuật Bắt Buộc:

1. **Quy Tắc Checkpoint Phân Trang Của Delta Pull (P0):**
   - Khi `hasMore === true`: CHỈ được cập nhật checkpoint lên `nextRevision` **SAU KHI** đã áp dụng thành công toàn bộ các delta của trang đó vào IndexedDB.
   - Khi `hasMore === false`: được cập nhật checkpoint lên `currentServerRevision` **SAU KHI** local transaction đã commit.
   - Nếu transaction gặp lỗi hoặc quota exceeded: checkpoint tuyệt đối **KHÔNG ĐƯỢC THAY ĐỔI**.
   - Mọi server revision và client cursor phải được lưu trữ dưới dạng **Decimal String** (PostgreSQL 64-bit BIGINT), so sánh bằng `BigInt(...)`, tuyệt đối không ép kiểu sang JavaScript `number` gây mất độ chính xác.

2. **Cách Ly Tuyệt Đối Theo Account Scope (`ownerScope`) (P0):**
   - Toàn bộ stores (`sync_meta`, `pending_mutations`, `quarantined_mutations`, `snapshot_staging_store`, `preferences`) đều phải phân vùng chặt chẽ theo `ownerScope` (`guest:<id>` và `account:<id>`).
   - Cấm dùng khóa đơn lẻ `mutationId` làm keyPath toàn cục. Khóa phải luôn là composite key `['ownerScope', 'mutationId']`.
   - Ngăn chặn triệt để rò rỉ chéo khi logout, switch account, Guest Claim hoặc trạng thái `TRANSITIONING` vô tình đẩy mutation của tài khoản khác lên server.

3. **Cấm Tự Động Replay Pending Mutations Sau HTTP 410 (P0):**
   - Khi server trả về `HTTP 410 Gone (SYNC_REVISION_EXPIRED)`, toàn bộ delta lịch sử giữa checkpoint cũ và snapshot đã bị GC xóa bỏ.
   - Việc một bản ghi không có trong snapshot **không chứng minh** rằng mutation `UPSERT` cũ được phép tạo lại bản ghi đó.
   - Chỉ những mutation có bằng chứng nhân quả (causal proof) và epoch hợp lệ mới được tiếp tục xử lý.
   - Các mutation không đủ bằng chứng nhân quả bắt buộc phải đưa vào `quarantined_mutations`, giữ nguyên `mutationId`, `payload` và `baseServerRevision` gốc. **Cấm tự động sửa `baseServerRevision`, cấm âm thầm phát sinh mutation ID mới.**
   - Đối với `HTTP 409 Conflict (SNAPSHOT_INVALIDATED)`: Hủy bỏ toàn bộ staging thuộc session cũ và khởi động lại quá trình tải snapshot từ trang 1. Tuyệt đối không swap snapshot chưa hoàn chỉnh.

4. **Bảo Vệ Chống Phục Sinh (Anti-Tombstone Resurrection):**
   - Không cho phép bất kỳ mutation cục bộ nào làm sống lại bản ghi đã bị Server đánh dấu xóa (Tombstone).
   - Khi nhận `REJECTED_TOMBSTONE` từ Server hoặc gặp delta `DELETE`, local replica lập tức xóa bản ghi tương ứng khỏi local store.

5. **Phân Định Rõ Ràng Ngữ Nghĩa Epoch:**
   - Miền **HISTORY**: Áp dụng kiểm tra đẳng thức nghiêm ngặt (`mutation.observedHistoryEpoch === server.storyHistoryEpoch`).
   - Miền **PROGRESS**: Áp dụng kiểm tra causal epoch guard với quan hệ `< effectiveHistoryEpoch` (cho phép tiến trình đọc mới nếu client đã quan sát revision xóa lịch sử).

6. **Web Locks API Là Cơ Chế Độc Quyền Duy Nhất Cho Tab Leader:**
   - Web Locks API (`navigator.locks`) là cơ chế mutual exclusion duy nhất chứng minh quyền Tab Leader, được khóa theo `ownerScope` (`omninovel_sync_leader:${ownerScope}`).
   - Khi một tab giữ lock, nó trở thành Tab Leader duy nhất được phép chạy push/pull workers. Lock tự động giải phóng khi tab đóng, reload hoặc crash.
   - `BroadcastChannel` chỉ đóng vai trò là bus truyền thông tin sự kiện giữa các tab (thông báo leader mới, báo trạng thái sync, kích hoạt re-render UI), **không phải cơ chế chứng minh quyền Leader**.

7. **Tính Nguyên Tử Khi Ghi Local Mutation + Pending Queue (Atomic Primitive):**
   - Ghi dữ liệu người dùng cục bộ (`bookmarks`, `progress`, `history`, `preferences`) VÀ đưa vào hàng đợi `pending_mutations` phải được thực thi trong **CÙNG MỘT** IndexedDB transaction.
   - Tuyệt đối không để xảy ra kịch bản ghi local thành công nhưng enqueue thất bại khiến thay đổi bị kẹt cục bộ vĩnh viễn không đồng bộ lên Cloud.

8. **Xử Lý Authoritative Delta Sau `CONFLICT_MERGED`:**
   - Server response của `POST /sync/mutations/batch` không có trường `resolvedPayload`.
   - Khi nhận kết quả `status === 'CONFLICT_MERGED'`, Web Client không được giả định có payload hợp nhất trong response mà phải kích hoạt pull authoritative delta từ Server để cập nhật replica.

9. **Bảo Toàn Schema Hiện Hữu & Local Persistence Miền PREFERENCE:**
   - Nâng cấp trên cùng CSDL `omninovel_local_v2` lên `DB_VERSION = 3` bằng `onupgradeneeded`.
   - Giữ nguyên 100% dữ liệu, keyPath, indexes và hành vi của 3 store cũ (`bookmarks`, `progress`, `history`).
   - Bổ sung store `preferences` phân vùng theo `ownerScope` để lưu trữ dữ liệu domain `PREFERENCE` (không được bỏ qua delta hoặc snapshot của domain này).
   - Khóa mapping: `chapterReadStates` từ API snapshot ánh xạ vào store `history` trong IndexedDB (với `maxProgressPercentage` -> `progressPercentage`).

---

## 2. Cấu Trúc Thành Phần & File Mapping

```
packages/shared/src/
├── types/
│   └── sync.types.ts                 <-- [Bước 1 - MỚI] Canonical Shared Sync Contracts (phản ánh 100% Backend DTOs)
apps/web/src/lib/
├── storage/
│   ├── indexed-db-client.ts          <-- [Bước 2 - NÂNG CẤP] DB_VERSION 3, bổ sung 5 object stores & migration logic
│   └── sync-storage.ts               <-- [Bước 2 - MỚI] DAL & Atomic Transaction Primitives cho Sync stores
└── sync/
    ├── web-sync.types.ts             <-- [Bước 3 - MỚI] Client-specific sync interfaces & state machine
    ├── tab-leader-election.ts        <-- [Bước 3 - MỚI] Web Locks API + BroadcastChannel coordinator
    ├── mutation-queue.ts             <-- [Bước 4 - MỚI] Pending mutation queue, atomic enqueue & quarantine (FROZEN CLEAN)
    ├── causal-projection-engine.ts   <-- [Bước 5.2c - MỚI] Pure deterministic Resolve(Shadow, Pending, Grace) engine
    ├── projection-hydrator.ts        <-- [Bước 5.2c - MỚI] Atomic single-tx IDB reload hydrator & Degraded Compatibility
    ├── delta-pull-reconciler.ts      <-- [Bước 5.2d - KẾ TIẾP] Kéo /sync/changes, paginated checkpoint & atomic apply
    ├── snapshot-reconciler.ts        <-- [Bước 6 - MỚI] Safe 410 Full Resync, Snapshot Staging & 409 restart
    ├── web-sync-coordinator.ts       <-- [Bước 7 - MỚI] Facade điều phối toàn bộ chu trình sync (Online/Offline)
    └── index.ts                      <-- [Bước 7 - MỚI] Public exports cho UI & Hooks
```

---

## 3. Thiết Kế Chi Tiết Schema IndexedDB v3 (Bước 2)

### Bảng Danh Mục Object Stores (`DB_NAME = 'omninovel_local_v2'`, `DB_VERSION = 3`):

| Store Name | KeyPath | Indexes | Mục Đích |
| :--- | :--- | :--- | :--- |
| `bookmarks` *(Hiện hữu)* | `['ownerScope', 'storyId']` | — | Lưu bookmark truyện cục bộ (giữ nguyên). |
| `progress` *(Hiện hữu)* | `['ownerScope', 'storyId']` | — | Lưu vị trí đọc gần nhất của truyện (giữ nguyên). |
| `history` *(Hiện hữu)* | `['ownerScope', 'storyId', 'chapterId']` | `by_owner_time: ['ownerScope', 'lastReadAt']` | Lưu lịch sử đọc từng chương (giữ nguyên). |
| `preferences` *(Mới)* | `['ownerScope', 'key']` | — | Lưu cài đặt & tùy biến người dùng theo account scope. |
| `sync_meta` *(Mới)* | `ownerScope` | — | Lưu checkpoint (`lastSyncedServerRevision`), `minActiveRevision`, `effectiveHistoryEpochs`, `syncState`. |
| `pending_mutations` *(Mới)* | `['ownerScope', 'mutationId']` | `by_scope_created: ['ownerScope', 'createdAt']` | Hàng đợi mutation cần đẩy lên server. |
| `quarantined_mutations` *(Mới)* | `['ownerScope', 'mutationId']` | `by_scope_rejected: ['ownerScope', 'rejectedAt']` | Mutation bị server từ chối / stale, chờ triage. |
| `snapshot_staging_store` *(Mới)* | `['ownerScope', 'sessionId', 'domain', 'entityKey']` | `by_scope_session: ['ownerScope', 'sessionId']` | Lưu tạm snapshot nhiều trang khi xử lý HTTP 410. |

---

## 4. Kế Hoạch Kiểm Thử Tự Động (Test Matrix & Verification)

1. **Shared Contracts Conformance Tests (`packages/shared/src/test/sync-contracts.spec.ts`):**
   - Khớp 100% các enums: `SyncDomain`, `SyncOperation`, `MutationExecutionStatus` (có `DOMAIN_NOT_SUPPORTED`).
   - Tái sử dụng `ReadingMode` chuẩn từ package `shared`.
   - Khớp các interface: `ClientMutationDto` (optional `clientCreatedAt`), `MutationResultItemDto` (`assignedRevision: string | null`), `SyncChangesResponseDto` (`nextRevision: string | null`), `SyncSnapshotResponseDto`.
2. **IndexedDB v3 Migration & Primitive Tests (`apps/web/src/test/indexed-db-v3-migration.spec.ts`):**
   - Nâng cấp từ v1 lên v3: bảo toàn 100% dữ liệu cũ trong `bookmarks`, `progress`, `history`.
   - Nâng cấp từ database mới hoàn toàn (fresh DB) lên v3.
   - Thao tác nguyên tử: ghi `recordReadingSessionWithMutation` hoặc `saveBookmarkWithMutation` đảm bảo ghi cả local store và `pending_mutations` trong cùng 1 transaction; rollback hoàn toàn nếu một trong hai thất bại hoặc quota exceeded.
   - Đảm bảo cách ly đa scope: ghi scope `account:user-1` không nhìn thấy / không ảnh hưởng tới scope `guest:device-1`.
   - Kiểm tra error handling: quota exceeded, database blocked / version change.
3. **Build & Hosted CI:**
   - `npm run test` (Vitest) toàn bộ Web suite pass 100%.
   - `npm run build` (Next.js 16) pass không có lỗi TypeScript.
   - Hosted CI 7/7 Jobs Green.

---

## 5. Tiến Độ Triển Khai Chi Tiết (Step-by-Step Execution Plan)

- [x] **Bước 1:** Khởi tạo canonical types trong `packages/shared/src/types/sync.types.ts` và export qua `packages/shared`. Viết conformance test (8/8 PASS).
- [x] **Bước 2:** Nâng cấp `apps/web/src/lib/storage/indexed-db-client.ts` lên `DB_VERSION = 3`, thêm 5 object stores mới, cung cấp atomic write + enqueue primitives. Remediated P0-01 (add() mutation immutability, entity/domain/op alignment) và P1-01 (rollback suite: duplicate mutation ConstraintError rollback, QuotaExceededError rollback, v2->v3 migration, onblocked handling — 18/18 PASS); đồng bộ sentinel `all` / UUID `00000000-0000-0000-0000-000000000000` và allowlist `reader_theme` — **ACCEPTED LOCAL** ✅.
- [x] **Bước 3:** Cài đặt `apps/web/src/lib/sync/web-sync.types.ts` và `apps/web/src/lib/sync/tab-leader-election.ts` quản lý bầu chọn Leader đa tab qua Web Locks API (`navigator.locks`) & BroadcastChannel. Đã khắc phục triệt để P0-02 (Fail-closed khi thiếu Web Locks API, role DISCONNECTED, cấm sync) và P0-03 (Loại bỏ race condition nhả lock bằng pre-allocated release promise, try/finally và regression tests đồng bộ cho stepDown, destroy, setActiveScope trong onRoleChange — 11/11 PASS, 694/694 web tests PASS) — **REMEDIATED & VERIFIED** ✅.
- [x] **Bước 4:** Cài đặt `apps/web/src/lib/sync/mutation-queue.ts` quản lý hàng đợi, chống rebase bừa bãi và cách ly quarantined mutations. Đã khắc phục triệt để:
  - **P0-04:** Bảo vệ toàn diện async boundary trong `handleTransientFailure` và `handleNetworkFailure`: truyền cố định `batchOwnerScope` & `batchScopeGeneration`, kiểm tra generation trước và sau mỗi await IndexedDB, không dùng `this.ownerScope` động; loại bỏ legacy `LocalPendingMutation[]` overload; thêm regression tests cho scope switch giữa chừng và $A \to B \to A$.
  - **P0-05:** Khóa tuyệt đối requeue đối với `REJECTED_STALE` và `HTTP_410_GONE` ở cả tầng MutationQueue và IndexedDB DAL cho tới khi Step 6 Causal Triage Engine hoàn thành; loại bỏ lỗ hổng caller tự khai báo `{ triageApproved: true }`.
  - **P0-06:** Bắt buộc (mandatory) `IdentityStateProvider` trong `MutationQueueOptions` với phương thức `canMutateUserState()` bắt buộc; fail-closed khi thiếu provider, transitioning hoặc unverified scope; tái kiểm tra trạng thái authority sau await `getPendingMutations` trong `preparePushBatch`.
  - **P1 Primitives:** Bổ sung primitive nguyên tử `incrementPendingMutationRetryAtomic` trong single IDB readwrite transaction; persistent `nextRetryAt` trong IndexedDB; atomic tombstone eviction + pending removal.
  - **Verification:** 34/34 tests PASS trong `mutation-queue.spec.ts`, toàn bộ 54 test files (730/730 tests) PASS, TypeScript typecheck 0 lỗi, Next.js 16 production build SUCCESS — **STEP 4 ACCEPTED LOCAL** ✅.
- [x] **Bước 4a (Remediation & Concurrency Hardening):** Khắc phục toàn diện race conditions và củng cố ranh giới thẩm quyền bất đồng bộ theo Directive Step 4a:
  - **P1-01 (Atomic Retry & Quarantine Decision):** Triển khai primitive nguyên tử `recordTransientFailureAtomic()` trong IndexedDB DAL (`indexed-db-client.ts`), mở 1 transaction `readwrite` duy nhất trên cả `STORE_PENDING_MUTATIONS` và `STORE_QUARANTINED_MUTATIONS`. Tính toán tăng retry, exponential backoff và quyết định chuyển sang `quarantined_mutations` (khi chạm ngưỡng `maxRetries`) hoàn toàn trong transaction lock; loại bỏ hoàn toàn mô hình read-then-write trong JavaScript giữa `getPendingMutation()` và `updatePendingMutationRetry()`.
  - **P0-07 (Async Authority Boundary Hardening):** Chuẩn hóa cơ chế kiểm tra thẩm quyền bất đồng bộ qua helper `assertAuthorityAtBoundary(expectedScope?, expectedGeneration?)` tích hợp vào mọi ranh giới async (`enqueue`, `preparePushBatch`, `processServerBatchResults`, `handleNetworkFailure`, `handleTransientFailure`, `quarantine`, `requeue`). Bổ sung synchronous admission guard callback `checkAdmission?: () => void` được kích hoạt ngay sau khi `await getDatabase()` hoàn thành và trước khi mở transaction trên IndexedDB (`enqueuePendingMutation`, `recordTransientFailureAtomic`, `quarantinePendingMutationByKey`, `requeueQuarantinedMutation`), ngăn chặn tuyệt đối ghi đè stale scope sau await.
  - **P0-08 (In-Flight Generation Isolation):** Chuyển đổi cơ chế theo dõi in-flight từ unversioned `inFlightSet: Set<string>` sang generation-scoped `inFlightMap: Map<string, number>` (`mutationId -> scopeGeneration`). Phương thức `releaseInFlight` chỉ giải phóng mutation khi generation khớp chính xác với batch generation, ngăn chặn triệt để late callback / release của generation cũ vô hiệu hóa in-flight lock của chu kỳ tài khoản mới ($A \to B \to A$).
  - **Deterministic Regression Matrix (RT-01 đến RT-13):** Bổ sung 10 test case mới mô phỏng chính xác interleaving, concurrent transient failures, database acquisition delay, generation mismatch, và identity transition abort.
  - **Nghiệm thu Local:** 44/44 tests `mutation-queue.spec.ts` PASS, 75/75 sync tests PASS, 54/54 test suites (740/740 tests) toàn web PASS, TypeScript 0 lỗi, Next.js 16 build SUCCESS — **STEP 4a CLOSED / FROZEN CLEAN LOCAL** ✅.
- [x] **Bước 4a.1 (Final Mutation Queue Hardening & Batch Ownership):** Khắc phục toàn diện lỗ hổng stale in-flight release, batch ownership và receipt authority admission:
  - **P0-09 (Generation-Safe & Batch-Safe In-Flight Ownership):** Mở rộng cấu trúc in-flight sang `InFlightOwner { ownerScope, scopeGeneration, batchId }`. Thu hẹp chữ ký `releaseInFlight(batch: PreparedPushBatch)` loại bỏ hoàn toàn các overload array không an toàn; kiểm tra nghiêm ngặt `currentOwner.ownerScope === batch.ownerScope && currentOwner.scopeGeneration === batch.scopeGeneration && currentOwner.batchId === batch.batchId`. Ngăn chặn triệt để kịch bản $A \to B \to A$ hoặc hai batch khác nhau trong cùng generation giải phóng nhầm in-flight token của nhau.
  - **P0-09B (Stale Receipt Must Not Mutate New Batch State):** Trước khi thực hiện bất kỳ DAL write nào trong `processServerBatchResults()`, bắt buộc xác minh `isBatchOwner(batch, mutation.mutationId)`. Nếu mutation đã được batch mới sở hữu hoặc đã được release/settle, stale receipt bị bỏ qua an toàn, không xóa pending, không evict replica, không quarantine nhầm. Chuyển thời điểm giải phóng in-flight token ra SAU KHI DAL transaction commit thành công.
  - **P0-10 (Complete Pre-Transaction Authority Admission):** Bổ sung đồng bộ `options?: { checkAdmission?: () => void }` vào toàn bộ các DAL write methods: `deletePendingMutation`, `deletePendingMutationsBatch`, `quarantineMutation`, `deleteQuarantinedMutation`, `clearQuarantinedMutations`, `evictReplicaAndRemovePending`. Đảm bảo `checkAdmission()` chạy đồng bộ ngay sau `await this.getDatabase()` và trước khi mở transaction trên IndexedDB.
  - **Post-Commit Callback Safety:** Re-verify authority trước khi phát các continuation callbacks (`onMutationQuarantined`, `onReplicaEvicted`, `onAuthoritativeDeltaPullRequired`), ngăn chặn hoàn toàn việc phát callback cho stale scope sau khi transaction đã commit.
  - **Deterministic Regression Matrix (RT-14 đến RT-23):** Bổ sung 10 regression test cases mới mô phỏng production call paths: stale `processServerBatchResults` & `handleNetworkFailure` sau $A \to B \to A$, same-generation batch isolation, transaction admission races (APPLIED, REJECTED_STALE, REJECTED_TOMBSTONE, delete/clear quarantine), real IndexedDB abort rollback (`tx.abort()`), post-commit callback suppression, và duplicate callback safety.
  - **Nghiệm thu Local:** 54/54 tests `mutation-queue.spec.ts` PASS, 85/85 sync tests PASS, 54/54 test suites (750/750 tests) toàn web PASS, TypeScript 0 lỗi, Next.js 16 build SUCCESS — **STEP 4 CLOSED / FROZEN CLEAN LOCAL** ✅.
- [x] **Bước 4a.2 (Strict Batch Ownership, Concurrent Settlement & Callback Failure Semantics — Final Closure):** Khắc phục toàn diện các vấn đề phát hiện tại Gate Review Step 4a.1 và các vòng Gate Review tiếp theo:
  - **P0-11 (Strict Ownership for Transient Failure):** Loại bỏ hoàn toàn legacy overload `batchOrScope: PreparedPushBatch | string` và suy đoán `batchId` từ in-flight map trong `handleTransientFailure()`. Narrow chặt chẽ thành `(batch: PreparedPushBatch, mutation: LocalPendingMutation, error: Error)`. Đột nhập cấm triệt để: mutation không thuộc sở hữu của batch (`!isBatchOwner(batch, mutation.mutationId)`) lập tức no-op, cấm retry/quarantine. Loại bỏ `assertBatchOwnershipOrUnowned()` khỏi DAL admission path, thay bằng `assertBatchOwnership(batch, mutation.mutationId)`.
  - **P0-12 (Concurrent Batch Settlement Race & Lifecycle State Machine):** Triển khai Batch Lifecycle State Machine với các trạng thái tường minh: `'ACTIVE' | 'PROCESSING' | 'SETTLED' | 'RELEASED' | 'FAILED'`. Cơ chế `tryClaimBatchProcessing(batch, intent)` thực hiện claim đồng bộ (`PROCESSING`) TRƯỚC BẤT KỲ `await` nào, đảm bảo mutual exclusion tuyệt đối giữa các concurrent receipt callbacks và network failure handlers. Ngăn chặn triệt để duplicate destructive writes, duplicate quarantine callbacks và hanging processing state.
  - **P1-04 & Blocker P0 (Reconciliation Obligation & Immediate Ingestion):** Ghi nhận nhu cầu reconciliation (`pendingReconciliationBatches.add(batch.batchId)` và `record.reconciliationRequired = true; record.reconciliationSettled = false;`) ngay khi `CONFLICT_MERGED` commit thành công vào IndexedDB, không chờ đến khi pull callback được gọi hoặc thất bại. Nhờ đó, trong kịch bản mixed partial failure (mutation A `CONFLICT_MERGED` thành công, mutation B sau đó bị lỗi DAL), nghĩa vụ reconciliation không bao giờ bị mất khi batch được retry (RT-36).
  - **P0 (Settlement Guard Against Unresolved Reconciliation):** Phương thức `markBatchSettled(batchId)` kiểm tra chặt chẽ nghĩa vụ reconciliation còn tồn đọng: nếu batch có `reconciliationRequired && !reconciliationSettled` hoặc nằm trong `pendingReconciliationBatches`, việc chuyển sang `SETTLED` bị chặn đứng hoàn toàn, giữ nguyên trạng thái `FAILED`. Ngăn chặn triệt để các failure callbacks muộn (như `handleNetworkFailure()`) vô tình khóa mất đường gọi `retryBatchReconciliation()` (RT-37).
  - **P0/P1 (Retry Preconditions & Callback Verification):** `retryBatchReconciliation()` yêu cầu nghiêm ngặt 2 điều kiện tiên quyết: (1) batch phải có nghĩa vụ reconciliation thực sự (từ chối batch ACTIVE hoặc không có pending reconciliation); (2) callback `onAuthoritativeDeltaPullRequired` bắt buộc phải được cấu hình (ném `AuthoritativePullTriggerError` và không đánh dấu settled nếu thiếu callback) (RT-38).
  - **P0 (Early Settlement Guard for Unfinished In-Flight Mutations):** Củng cố điều kiện settlement của `retryBatchReconciliation()` và `markBatchSettled()`: khi delta pull callback hoàn tất thành công, nghĩa vụ reconciliation được giải phóng (`reconciliationSettled = true; reconciliationRequired = false`), nhưng nếu batch vẫn sở hữu mutations chưa hoàn tất (còn in-flight token), batch TUYỆT ĐỐI KHÔNG chuyển sang `SETTLED` mà giữ nguyên trạng thái `FAILED`. Giữ vững đường phục hồi tường minh: (1) qua `processServerBatchResults()` để tiếp tục xử lý các mutation dở dang và chỉ SETTLED khi toàn bộ hoàn tất; hoặc (2) qua `recoverFailedBatch()` giải phóng in-flight token để `preparePushBatch()` gắp lại vào batch mới (RT-39, RT-39b).
  - **P1 (Partial Batch Failure Recovery & Clean Unstarted Processing):** Hỗ trợ 2 luồng khôi phục sau partial batch failure: (1) Trực tiếp retry batch cũ (skip mutation đã commit, xử lý tiếp mutation dở dang); (2) Gọi `recoverFailedBatch(batch)` giải phóng in-flight locks của các mutation chưa commit để batch mới có thể gói lại mà không phát sinh replay mutation đã commit. Đồng thời đảm bảo nếu `releaseInFlight(batch)` được gọi khi batch đang ở trạng thái `PROCESSING`, các mutation chưa bắt đầu sẽ bị bỏ qua an toàn bởi ownership guard (`!isBatchOwner`), còn mutation đang chờ DAL transaction sẽ bị từ chối bởi admission check (`StaleBatchRejectedError`) (RT-35).
  - **Deterministic Concurrency Tests (Eliminate Polling):** Loại bỏ hoàn toàn `setTimeout` trong các bài test đồng quy RT-27, RT-28, RT-29; thay bằng deterministic two-way barrier signals (`enteredBarrier` / `barrierRelease`).
  - **Deterministic Regression Matrix (RT-25 đến RT-39b):** Đầy đủ 16 regression test cases chuyên sâu mô phỏng các race condition và kịch bản lỗi biên thực tế.
  - **Nghiệm thu Local:** 70/70 tests `mutation-queue.spec.ts` PASS, 101/101 sync tests PASS, 54/54 test suites (766/766 tests) toàn web PASS, TypeScript 0 lỗi (`tsc --noEmit`), Next.js 16 build SUCCESS — **STEP 4 CLOSED / FROZEN CLEAN LOCAL** ✅.
- [x] **Bước 5.1 (Backend Contract Remediation — Canonical Delta Payloads & Tombstones):**
  - **P0-01 (History Conflict Resolver):** Chấp thuận `HISTORY DELETE` mà không bắt buộc `observedHistoryEpoch` (trả về `APPLIED` cho cả story-wide và global `all`), giữ nguyên strict epoch equality cho `HISTORY UPSERT`.
  - **P0-02 (Canonical HISTORY UPSERT Payloads across all write paths):** Cả hai đường ghi qua `SyncService.pushMutations` và `StoriesService.recordReadingProgress` đều áp dụng `RETURNING max_progress_percentage` khi upsert `chapter_read_states`, sau đó phát delta `SyncDomain.HISTORY` với `progressPercentage = actualMaxProgress` (canonical committed state) thay vì giá trị request của client.
  - **P0-03 (HISTORY DELETE Epoch Payload & Dual Tombstones):** `SyncService.pushMutations` với `HISTORY DELETE` gán `resolvedPayload = { storyId, epoch: newEpoch }` (story-wide) hoặc `{ epoch: newEpoch }` (global); chuẩn hóa `changeLogEntityId = '00000000-0000-0000-0000-000000000000'` cho global sentinel (kể cả khi input gửi `'all'`); ghi `sync_tombstones` cả UUID sentinel lẫn alias `'all'`.
  - **Evidence Debt Remediation & Test Matrix:**
    - DT-19A: Unit Conflict Resolver Matrix (`conflict-resolvers.spec.ts` — 26/26 PASS).
    - DT-19B: Dedicated integration test kiểm thử độc lập story-wide HISTORY DELETE (chỉ xóa đúng truyện chỉ định, các truyện khác giữ nguyên, ghi story tombstone, bump epoch).
    - DT-19C: Integration test kiểm thử idempotent retry của HISTORY DELETE (nhận `DEDUPLICATED` receipt, không tăng epoch 2 lần, không làm hỏng state).
    - DT-20A: Integration test kiểm thử global HISTORY DELETE (`entityId: 'all'` chuẩn hóa UUID sentinel và ghi dual tombstones).
    - DT-20B: Integration test kiểm thử `SyncService.pushMutations` với HISTORY UPSERT phát canonical max progress từ DB RETURNING.
    - DT-20C: Integration test kiểm thử `StoriesService.saveReadingProgress` phát canonical delta HISTORY UPSERT từ DB RETURNING.
    - DT-20D: Integration test kiểm thử HISTORY UPSERT sau clear history từ chối stale epoch (`REJECTED_TOMBSTONE` / `STALE_HISTORY_EPOCH`) và chấp thuận matching epoch mới.
    - Toàn bộ 19/19 integration tests trong `sync-hub-concurrency.integration-spec.ts` PASS, 50/50 unit test suites (606 tests) toàn API PASS, `nest build` 0 lỗi TypeScript — **PHASE 5.1 CODE PASS & EVIDENCE DEBT FULLY RESOLVED** ✅.
- [x] **Bước 5.2a (IndexedDB v4 Migration, Baseline Lifecycle & Authoritative READY Proof Boundary Remediation):**
  - **Schema Nâng Cấp:** Nâng cấp `apps/web/src/lib/storage/indexed-db-client.ts` lên `DB_VERSION = 4`, bổ sung store thứ 9 `sync_authoritative_replicas` với 2 indexes `by_scope_domain: ['ownerScope', 'domain']` và `by_scope_revision: ['ownerScope', 'serverRevision']`.
  - **100% Data Preservation:** Nâng cấp tự động từ v3 lên v4 bảo toàn 100% dữ liệu của 8 stores hiện hữu (`bookmarks`, `progress`, `history`, `preferences`, `sync_meta`, `pending_mutations`, `quarantined_mutations`, `snapshot_staging_store`); khởi tạo store thứ 9 rỗng.
  - **P0 Remediation (Authoritative READY Proof Boundary & Checkpoint Immutability):**
    - Mọi bản ghi `sync_meta` khi nâng cấp hoặc tạo mới với checkpoint "0" đều có `authoritativeBaselineStatus: 'UNINITIALIZED'`.
    - `setAuthoritativeBaselineStatus(ownerScope, status)` nghiêm cấm tuyệt đối chuyển sang `'READY'` (`ReadyStatusTransitionForbiddenError`), chỉ cho phép đặt `'UNINITIALIZED'` hoặc `'BOOTSTRAPPING'`. Trạng thái `'READY'` không được cấp trong Step 5.2a mà được bảo lưu cho Step 6 verified bootstrap finalization transaction.
    - Loại bỏ hoàn toàn các primitive giả lập hoặc test bypass khỏi production DAL (`finalizeAuthoritativeBaseline`, `_unsafeSetAuthoritativeBaselineStatusForTesting`).
    - `putSyncMeta()` củng cố bảo vệ kép:
      1. Cấm chuyển đổi từ non-READY sang `READY` (`ReadyStatusTransitionForbiddenError`).
      2. Khóa bất biến checkpoint và epoch trên READY scope: cấm sửa đổi `lastSyncedServerRevision` hoặc `effectiveHistoryEpochs` của một scope đã READY thông qua `putSyncMeta` thông thường (`CHECKPOINT_MUTATION_FORBIDDEN`). Việc nâng checkpoint thuộc thẩm quyền độc quyền của atomic delta ingestion (Step 5.2b).
      3. Cho phép cập nhật các metadata vận hành lành tính (`syncState`, `lastSyncTimestamp`, `lastErrorMessage`).
    - Hỗ trợ tài khoản server rỗng hợp lệ tại checkpoint "0" mà không có lỗi từ chối revision giả định.
    - Đánh dấu tường minh `putAuthoritativeShadow` là internal/test-only primitive; cấm production Delta Pull gọi trực tiếp (chờ Step 5.2b `applyAuthoritativeDeltaPage`).
  - **Bộ Kiểm Thử Toàn Diện (ST-07 & ST-10 Mở Rộng — 20 Tests):**
    - ST-07A: 9 stores, composite keyPaths, indexes.
    - ST-07B: Bảo toàn dữ liệu 100% trên cả 8 stores v3.
    - ST-07C: onversionchange graceful shutdown.
    - ST-07D: Real multi-connection upgrade handshake qua onversionchange.
    - ST-10A/B: UNINITIALIZED default cho missing meta, checkpoint 0, checkpoint > 0.
    - ST-10C/D: Fail-closed admission guard và interrupted bootstrap recovery.
    - ST-10E: Cách ly đa scope và tenant guard.
    - ST-10F: Authoritative shadow CRUD primitives.
    - ST-10G: PurgeScope dọn sạch toàn diện cả 9 stores cho target scope, bảo toàn 100% dữ liệu 9 stores của keep scope.
    - ST-10H: Negative admission regressions (cấm direct READY, cấm putSyncMeta bypass, cấm checkpoint mutation trên READY scope, cấm epoch mutation trên READY scope, cho phép benign syncState update, hỗ trợ legitimate empty-account tại rev 0, xác nhận zero bypass methods trong production DAL).
    - ST-10I: Interrupted bootstrap durability across connection reopen (lưu bền vững BOOTSTRAPPING, duy trì fail-closed unready).
  - **Nghiệm Thu Local:** 20/20 tests `indexed-db-v4-migration.spec.ts` PASS, 55/55 test files (786/786 tests) toàn bộ Web suite PASS, TypeScript (`tsc --noEmit`) 0 lỗi, Next.js 16 production build SUCCESS — **STEP 5.2a REMEDIATION CLOSED & FROZEN CLEAN LOCAL** ✅.
- [ ] **Bước 5.2 (Web Delta Pull Reconciler & Phased Storage Rollout):**
  - **Gate Review Phán Quyết:** Phương án Revision 1 (`_syncStatus`) bị BLOCKED; Kiến trúc Revision 2 (`sync_authoritative_replicas` + Projection) được ACCEPTED IN PRINCIPLE; Đã hoàn thiện toàn diện **Storage Coexistence Revision 2.1 — Tombstone-Safe Shadow, Bootstrap Baseline & Causal Projection Contract** (chi tiết tại [`plans/phase_07c_storage_coexistence_design_v2.md`](file:///E:/Workspace2/Doctruyen_project/plans/phase_07c_storage_coexistence_design_v2.md)).
  - **Lộ trình Phased Rollout phân rã nghiêm ngặt (chờ Contract Gate Approval):**
    - [x] **Bước 5.2a:** IndexedDB v4 Migration & Baseline Lifecycle Remediation (`sync_meta.authoritativeBaselineStatus: 'UNINITIALIZED' | 'BOOTSTRAPPING' | 'READY'`, kiểm thử ST-07, ST-10A–I).
    - [x] **Bước 5.2b (Remediation & Hardening — CLOSED / FROZEN CLEAN):** Authoritative Shadow DAL & OCC Delta Ingestion (`apps/web/src/lib/storage/indexed-db-client.ts`, primitive `applyAuthoritativeDeltaPage`) — **Nghiệm thu chính thức tại baseline `4a78f9c`, Hosted CI Run `#42053644100` (7/7 PASS), với 55 CVE IDs trong `ai-worker.trivyignore` được quản trị theo ngoại lệ có thời hạn `SEC-REG-6.4.4A` (hạn rà soát `2026-12-01`) và VPS job là Docker Compose topology validation (chưa cấu hình `VPS_SSH_HOST`/`VPS_SSH_KEY`)**:
      - **P0-01 Remediation (Bắt buộc OCC Checkpoint):** `expectedCheckpoint` là bắt buộc (mandatory `string`), kiểm tra regex decimal; cấm hoàn toàn bypass OCC; đối soát nghiêm ngặt `expectedCheckpoint === currentCheckpoint`, ném `CheckpointConflictError` nếu lệch checkpoint (`P0-01A–D`).
      - **P0-02 Remediation (Delta Page Consistency & Server Boundaries):**
        - Bắt buộc `currentServerRevision`, `minActiveRevision`, `hasMore`.
        - Khi `hasMore: true`, bắt buộc `nextRevision !== null` và là decimal string (`P0-02A`).
        - Khóa cận trên server: `targetCheckpoint <= currentServerRevision` (`P0-02D`).
        - Khóa cận items: mọi change phải có `expectedCheckpoint < revision <= targetCheckpoint` (`P0-02B, P0-02C`).
        - Compaction retention gap guard: ném `COMPACTED_RETENTION_GAP` nếu client checkpoint > 0 rơi ra sau `minActiveRevision` (`P0-02E`).
      - **P0-03 Remediation (Delta Pagination Cursor Integrity):** Khi `hasMore: true`, trang bắt buộc có `changes.length > 0` và `nextRevision === lastChange.revision`; khi `hasMore: false`, bắt buộc `nextRevision === null`; rollback nguyên tử khi từ chối payload (`P0-03A–G`).
      - **P1-01 Remediation (HISTORY Epoch Monotonicity Guard):**
        - Global HISTORY DELETE bắt buộc `newEpoch > currentGlobalEpoch` (`P1-01A`).
        - Story-wide HISTORY DELETE bắt buộc `newEpoch > max(currentStoryEpoch, currentGlobalEpoch)` (`P1-01B, P1-01C`).
        - Chặn đứng intra-page non-monotonic epoch progression (`P1-01D`).
        - Xóa cascade sạch chapter history shadows + progress shadow; cập nhật `effectiveHistoryEpochs` (`P1-01E`).
      - **P1-02 Remediation (Concurrent Transaction Isolation & OCC Race):**
        - Race đồng quy cùng `expectedCheckpoint`: đúng 1 transaction thành công, transaction cạnh tranh nhận `CheckpointConflictError`, kiểm chứng đầy đủ shadow người thắng/người thua (`P1-02A`).
        - Hai `IndexedDbClient` độc lập cạnh tranh cùng DB (`P1-02B`).
        - Interleaved delayed-commit barrier: client B khởi tạo request với `expectedCheckpoint` cũ trong lúc transaction A đang in-flight trước khi commit và bị chặn bởi OCC (`P1-02C`).
        - Concurrent transactions đa scope (`P1-02D`) và read-after-write snapshot isolation (`P1-02E`).
      - Củng cố `putSyncMeta()`: Bảo vệ kép `minActiveRevision`, `lastSyncedServerRevision` và `effectiveHistoryEpochs` (so sánh không phụ thuộc thứ tự key qua `areEpochMapsEqual`) trên `READY` scopes.
      - Fail-Closed Baseline Boundary: Ingestion delta page tuyệt đối KHÔNG tự ý cấp trạng thái `READY`, bảo lưu cho Step 6 verified bootstrap finalization.
      - Bộ kiểm thử toàn diện đạt **41/41 tests PASS** (`src/test/indexed-db-authoritative-delta.spec.ts`), toàn bộ Web Vitest **827/827 PASS** (Commit `0fb3993` / `4a78f9c`, Hosted CI `#42053644100`).
    - [/] **Bước 5.2c (IMPLEMENTED — PENDING FINAL GATE REVIEW):** Pure Deterministic Causal Projection Engine & Hydration (KHÔNG pre-approved — chờ nghiệm thu riêng sau Security Remediation PR `#210`):
      - `apps/web/src/lib/sync/causal-projection-engine.ts`: Hàm thuần túy `resolveCausalProjection(AuthoritativeShadow, PendingMutations, OptionalGrace)` bất biến theo hoán vị đầu vào và hoàn toàn độc lập với RAM events / callback order / lịch sử phiên tab; chuẩn hóa entity key (`getCanonicalEntityKey`, `getEffectiveHistoryEpoch`, global sentinel `00000000-0000-0000-0000-000000000000` / `'all'`); bảo vệ kép Tombstone & Epoch (Revision 2.2 Mục 4 & P0-05: lọc `epoch < effectiveEpoch`, bảo toàn `4 === 4`, và chặn pending thiếu epoch có `baseServerRevision < tombstoneRevision`); cửa sổ Bounded Post-Receipt Grace (Revision 2.2 Mục 5 P0-04, mặc định TTL 5s hoặc tự thu hồi khi `syncedServerRevision >= assignedRevision`); suy diễn lịch sử đọc đơn điệu từ `PROGRESS`/`HISTORY`, nhận diện `needsHydration` + bổ sung presentation metadata từ catalog.
      - `apps/web/src/lib/sync/projection-hydrator.ts`: `SyncProjectionHydrator` và `hydrateProjectionFromIndexedDb` đọc nhất quán 7 object stores (`sync_meta`, `sync_authoritative_replicas`, `pending_mutations`, `bookmarks`, `progress`, `history`, `preferences`) trong **1 IndexedDB transaction duy nhất** để phục hồi sau reload; fail-closed vào `DEGRADED_COMPATIBILITY` mode (đọc legacy stores, phớt lờ unverified shadow) khi `authoritativeBaselineStatus !== 'READY'`; cung cấp `materializeToLegacyStores` trong 1 `readwrite` transaction duy nhất đọc lại fresh pending queue dưới khóa giao dịch để tuyệt đối không ghi đè user writes đồng thời (`ST-15`).
      - `apps/web/src/test/causal-projection-engine.spec.ts`: **19/19 tests PASS** bao phủ đầy đủ `ST-02`, `ST-03`, `ST-04`, `ST-06`, `ST-12`, `ST-13`, `ST-15`, permutation invariance, dual-layer suppression, bounded grace, fail-closed Degraded Compatibility/SSR và tích hợp Step 5.2b `applyAuthoritativeDeltaPage` + reload.
      - Tuân thủ Strict Scope Boundaries: giữ nguyên 100% `mutation-queue.ts` (FROZEN) và Step 5.2b `indexed-db-client.ts` (FROZEN), không tự ý cấp `READY`, không chứa Step 5.2d hoặc Step 6.
    - [ ] **Bước 5.2d:** Delta Pull Reconciler Integration & Full Web E2E Verification (Kéo `/sync/changes`, checkpoint phân trang, tích hợp Web Locks Tab Leader).
  - **Bảo toàn Step 4:** Tuyệt đối không can thiệp hay sửa đổi bất kỳ logic giao dịch nào của Step 4 Mutation Queue đã FROZEN CLEAN.
- [ ] **Bước 6:** Cài đặt `apps/web/src/lib/sync/snapshot-reconciler.ts` xử lý Safe 410 Gone Full Resync với staging, hủy bỏ staging khi gặp 409 snapshot invalidation.
- [ ] **Bước 7:** Tích hợp `apps/web/src/lib/sync/web-sync-coordinator.ts` và gắn kết với Auth/Identity/Reader hooks.
- [ ] **Bước 8:** Chạy kiểm thử toàn diện (Vitest, Next.js build), xác minh các kịch bản nghiệm thu và đẩy Git đồng bộ.

---

## 6. Hồ Sơ Bằng Chứng Nghiệm Thu Phase 5.1 & Step 4a.2 (Evidence Matrix)

### Phase 5.1 — Backend Contract Remediation: Canonical Delta Payloads, History Delete & Epoch Dual Tombstones

| Claim | Source File | Test / Gate | Commit SHA (Remediation / Head) | Hosted Run | Evidence Type | What This Does NOT Prove | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **C1: History Delete Idempotent Acceptance without Epoch (P0-01)** | `services/api/src/modules/sync/resolvers/history.resolver.ts` | DT-19A (`conflict-resolvers.spec.ts`) | `36a3b9d` / `e1ce7f3` | #41411013225 | Unit Conflict Resolver Matrix (26/26 PASS) | Không chứng minh client tự động cập nhật local epoch nếu không kéo delta | **PASS HOSTED** |
| **C2a: Story-wide History Delete Emits Committed Epoch (P0-01 / P0-03)** | `services/api/src/modules/sync/services/sync.service.ts` | DT-19B (`sync.service.spec.ts`) | `36a3b9d` / `e1ce7f3` | #41411013225 | Unit Sync Service Test | Không chứng minh phân quyền người dùng (đã được JwtAuthGuard kiểm soát) | **PASS HOSTED** |
| **C2b: Independent Story-wide History Delete Isolation (P0-01 / P0-03)** | `services/api/src/modules/sync/services/sync.service.ts` | DT-19B (`sync-hub-concurrency.integration-spec.ts`) | `36a3b9d` / `HEAD` | Local Postgres Container / Hosted CI | Dedicated PostgreSQL Integration Test (Story A deleted, Story B untouched, tombstone isolated) | Không chứng minh phân quyền người dùng (đã được JwtAuthGuard kiểm soát) | **PASS VERIFIED** |
| **C2c: Idempotent Retry of History Delete** | `services/api/src/modules/sync/services/sync.service.ts` | DT-19C (`sync-hub-concurrency.integration-spec.ts`) | `36a3b9d` / `HEAD` | Local Postgres Container / Hosted CI | PostgreSQL Integration Test (DEDUPLICATED receipt, no double epoch bump, no corruption) | Không thay thế client-side offline retry queue | **PASS VERIFIED** |
| **C3: Global History Delete UUID Normalization & Dual Tombstones (P0-03)** | `services/api/src/modules/sync/services/sync.service.ts` | DT-20A (`sync.service.spec.ts`, `sync-hub-concurrency.integration-spec.ts`) | `36a3b9d` / `e1ce7f3` | #41411013225 | Unit & Database Tombstone Verification | Không chứng minh client Web IDB v3 có thể parse nếu client chưa hỗ trợ composite key | **PASS HOSTED** |
| **C4: Canonical History Upsert via Sync Hub (P0-02)** | `services/api/src/modules/sync/services/sync.service.ts` | DT-20B (`sync.service.spec.ts`, `sync-hub-concurrency.integration-spec.ts`) | `36a3b9d` / `e1ce7f3` | #41411013225 | Database RETURNING Max Progress & Unit/Integration Test | Không ngăn client gửi số phần trăm nhỏ hơn (server tự bảo toàn monotonically) | **PASS HOSTED** |
| **C5: Canonical History Upsert via Stories Service (P0-02)** | `services/api/src/modules/stories/stories.service.ts` | DT-20C (`sync-hub-concurrency.integration-spec.ts`) | `36a3b9d` / `e1ce7f3` | #41411013225 | Full Database End-to-End Reading Flow Spec | Không chứng minh client offline (đây là API ghi trực tiếp khi online) | **PASS HOSTED** |
| **C5b: Stale Epoch Rejection & Fresh Epoch Acceptance (P0-01 / P0-05)** | `services/api/src/modules/sync/services/sync.service.ts` | DT-20D (`sync-hub-concurrency.integration-spec.ts`) | `36a3b9d` / `HEAD` | Local Postgres Container / Hosted CI | PostgreSQL Integration Test (Rejects stale epoch with REJECTED_TOMBSTONE; accepts matching new epoch) | Không chứng minh client tự động cập nhật local epoch nếu không kéo delta | **PASS VERIFIED** |
| **C6: Full API Regression Preservation** | `services/api` | 50/50 Unit Test Suites (606 tests PASS) + 23/23 E2E Suites (290 tests PASS) | `36a3b9d` / `e1ce7f3` | #41411013225 | Full Backend Suite & TypeScript compilation | Chưa chứng minh Phase 5.2 client reconciler | **PASS HOSTED** |
| **C7: Hosted CI Verification** | `.github/workflows/ci-cd.yml` | GitHub Actions Pipeline Run #41411013225 | `e1ce7f3` | #41411013225 | Hosted Production Infrastructure | **7/7 jobs SUCCESS (Web, Core API, Mobile, AI Worker, Security Audit, Docker Build & VPS Deploy hoàn tất trong 11m12s)** | **PASS HOSTED** |

---

### Step 4a.2 — Strict Batch Lifecycle, Reconciliation Recovery & Callback Failure Remediation

| Claim | Source File | Test / Gate | Commit SHA (Remediation / Head) | Hosted Run | Evidence Type | What This Does NOT Prove | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **C1: Strict Transient Failure Ownership (P0-11)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-25, RT-26 (`mutation-queue.spec.ts`) | `4f428b4` | #41262756504 | Unit & Async Admission Interleaving Test | Không chứng minh exactly-once network delivery qua mạng vật lý | **PASS HOSTED** |
| **C2: Concurrent Failure Claim (P0-12)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-27 (`mutation-queue.spec.ts`) | `4f428b4` | #41262756504 | Deterministic Two-Way Barrier Concurrency Test | Không chứng minh cross-tab mutual exclusion (được bảo vệ bởi Web Locks ở Step 3) | **PASS HOSTED** |
| **C3: Concurrent Terminal Receipt Claim (P0-12)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-28 (`mutation-queue.spec.ts`) | `4f428b4` | #41262756504 | Deterministic Two-Way Barrier & Idempotent Commit Test | Không thay thế server-side deduplication | **PASS HOSTED** |
| **C4: Receipt/Failure Mutual Exclusion (P0-12)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-29 (`mutation-queue.spec.ts`) | `4f428b4` | #41262756504 | Deterministic Two-Way Barrier Race Condition Test | Không chứng minh hành vi crash recovery của OS khi process bị kill đột ngột | **PASS HOSTED** |
| **C5: Partial Batch Recovery & Release during Processing (P0-12)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-30, RT-31, RT-35, RT-36 (`mutation-queue.spec.ts`) | `4f428b4` | #41262756504 | DAL Failure Injection, Mixed Partial Failure & Processing Release Test | Không phục hồi phần cứng đĩa nếu IndexedDB bị corrupt vật lý | **PASS HOSTED** |
| **C6: In-Memory Session Reconciliation Retry & Lifecycle Settlement (P1-04 & Blocker P0)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-32, RT-33, RT-37, RT-38, RT-39, RT-39b (`mutation-queue.spec.ts`) | `722ccb0` | #41267066209 | In-Memory Session Reconciliation Retry, Unfinished In-Flight Guard & Settlement Test | **Không chứng minh tính bền vững qua full page reload (pendingReconciliationBatches là trạng thái in-memory trong phiên tab; sau khi reload, việc đối soát delta pull phụ thuộc vào chu trình kiểm tra cursor checkpoint ban đầu của Step 5 / Step 7 khi khởi động coordinator)** | **PASS HOSTED** |
| **C7: Bounded Settlement Replay Protection (P0-12)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-34 (`mutation-queue.spec.ts`) | `722ccb0` | #41267066209 | Cache Eviction & In-Flight Ownership Boundary Test | Local settlement không chứng minh crash-safe recovery sau browser termination | **PASS HOSTED** |
| **C8: Atomic Retry Regression Preservation** | `apps/web/src/test/mutation-queue.spec.ts` | RT-01 đến RT-13, RT-24 (PASS) | `722ccb0` | #41267066209 | Full Mutation Queue Vitest Suite (70/70 PASS) | Chưa tích hợp toàn diện với Step 5 Delta Pull Reconciler | **PASS HOSTED** |
| **C9: Scope/Generation/Batch Isolation** | `apps/web/src/test/mutation-queue.spec.ts` | RT-14 đến RT-23 (PASS) | `722ccb0` | #41267066209 | Authority Boundary Interleaving Suite | fake-indexeddb không thay thế toàn bộ browser engine testing | **PASS HOSTED** |
| **C10: Complete Local Verification** | `apps/web` | Gates A–E (70 Queue, 101 Sync, 766 Web, Typecheck 0, Build SUCCESS) | `722ccb0` | #41267066209 | Full Local Acceptance Gates | Toàn bộ 54 files / 766 tests đã đối soát đồng bộ trên Hosted CI (7/7 jobs PASS) | **PASS HOSTED** |
| **C11: Hosted CI Status** | `.github/workflows/ci.yml` | GitHub Actions push pipeline | `722ccb0` | #41267066209 | Hosted CI Infrastructure | **PASS — 7/7 jobs SUCCESS (Web Client 766/766 tests + Playwright, NestJS Core API, AI Worker, Mobile Client, Security Scan, Docker Build & VPS Deploy hoàn tất trong 11m42s)** | **PASS HOSTED** |

---

### Step 5.2b — Authoritative Shadow DAL, OCC Delta Ingestion & Final Remediation Matrix (CLOSED / FROZEN CLEAN)

| Claim | Source File | Test / Gate | Commit SHA | Hosted Run | Evidence Type | What This Does NOT Prove | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **C1: Mandatory OCC Checkpoint Guard (P0-01)** | `apps/web/src/lib/storage/indexed-db-client.ts` | P0-01A–D, ST-05 (`indexed-db-authoritative-delta.spec.ts`) | `0fb3993 / 4a78f9c` | #42053644100 | Mandatory string validation & OCC conflict rejection tests (`CheckpointConflictError`) | Không ngăn chặn race trên 2 thiết bị khác nhau | **PASS HOSTED** |
| **C2: Delta Page Consistency & Server Boundaries (P0-02)** | `apps/web/src/lib/storage/indexed-db-client.ts` | P0-02A–F, ST-09 (`indexed-db-authoritative-delta.spec.ts`) | `0fb3993 / 4a78f9c` | #42053644100 | Page metadata, item boundary, server upper bound & retention gap tests (`COMPACTED_RETENTION_GAP`) | Không thay thế server validation trên backend | **PASS HOSTED** |
| **C2b: Delta Pagination Cursor Integrity & Server Contract Alignment (P0-03)** | `apps/web/src/lib/storage/indexed-db-client.ts` | P0-03A–G (`indexed-db-authoritative-delta.spec.ts`) | `0fb3993 / 4a78f9c` | #42053644100 | Invariant: `hasMore=true` requires non-empty changes and `nextRevision === lastChange.revision`; `hasMore=false` requires `nextRevision === null`. Tests for cursor overshoot, empty page, trailing cursor & atomic rollback | Không chứng minh kết nối mạng vật lý tới Core API | **PASS HOSTED** |
| **C3: HISTORY Epoch Monotonicity Guard (P1-01)** | `apps/web/src/lib/storage/indexed-db-client.ts` | P1-01A–E, ST-11 (`indexed-db-authoritative-delta.spec.ts`) | `0fb3993 / 4a78f9c` | #42053644100 | Strict epoch monotonicity rejection tests for global, story-wide, and intra-page deletes | Đã chuyển giao lọc hiển thị sang Step 5.2c Causal Projection Engine | **PASS HOSTED** |
| **C4: Concurrent Transaction Isolation & Deterministic Interleaving (P1-02)** | `apps/web/src/lib/storage/indexed-db-client.ts` | P1-02A–E (`indexed-db-authoritative-delta.spec.ts`) | `0fb3993 / 4a78f9c` | #42053644100 | Two independent `IndexedDbClient` instances racing, winner/loser full shadow verification, delayed-commit barrier (client B khởi tạo request với `expectedCheckpoint` cũ `'50'` trong lúc transaction A chưa commit và bị chặn bởi OCC conflict), multi-scope isolation & snapshot read | Không chứng minh client B đã thực sự đọc metadata từ IndexedDB trước khi transaction A commit; không chứng minh crash an toàn khi mất điện đĩa cứng | **PASS HOSTED** |
| **C5: Atomic Ingestion & Rollback (ST-01, ST-14)** | `apps/web/src/lib/storage/indexed-db-client.ts` | ST-01, ST-14 (`indexed-db-authoritative-delta.spec.ts`) | `0fb3993 / 4a78f9c` | #42053644100 | Single atomic readwrite transaction & transactional abort test (`tx.abort()`) | Không phục hồi phần cứng đĩa nếu IndexedDB bị corrupt vật lý | **PASS HOSTED** |
| **C6: Cascading Tombstone Eviction for Story-Wide & Global History (ST-11)** | `apps/web/src/lib/storage/indexed-db-client.ts` | ST-11A/B/C (`indexed-db-authoritative-delta.spec.ts`) | `0fb3993 / 4a78f9c` | #42053644100 | Story-wide and Global HISTORY DELETE cascading shadow eviction & epoch bump tests | Đã chuyển giao lọc hiển thị sang Step 5.2c Causal Projection Engine | **PASS HOSTED** |
| **C7: Authority Admission & Boundary Guard (ST-14B)** | `apps/web/src/lib/storage/indexed-db-client.ts` | ST-14B (`indexed-db-authoritative-delta.spec.ts`) | `0fb3993 / 4a78f9c` | #42053644100 | Synchronous admission guard rejection test before opening transaction | Không thể rollback nếu transaction đã commit trước khi authority bị hủy | **PASS HOSTED** |
| **C8: Complete Web & Hosted CI Verification (7/7 Jobs PASS, 827/827 Web Tests)** | `apps/web` / `.github/workflows/ci-cd.yml` | GitHub Actions Run #42053644100 (7/7 PASS) | `4a78f9c` | #42053644100 | 827/827 Web Vitest PASS (41 delta tests), Playwright E2E, Mobile Flutter, Core API, AI Worker, Security Audit, Docker Build & Trivy, VPS Topology Validation | VPS job chỉ xác thực Docker Compose topology vì chưa cấu hình `VPS_SSH_HOST` / `VPS_SSH_KEY` (không phải live VPS SSH deployment); chưa tích hợp Network Delta Pull (Step 5.2d) | **PASS HOSTED** |
| **C9: AI Worker Security Gate Governance (SEC-REG-6.4.4A — 55 Governed CVEs)** | `deploy/security` | Trivy Scan (`exit-code: 1`) + `validate-trivy-exceptions.py --test` (12/12 PASS) | `4a78f9c` | #42053644100 | 12/12 governance tests PASS; **55 CVE IDs** trong `deploy/security/trivy/ai-worker.trivyignore` (gồm `libexpat1`, `torch`, `zlib1g`/`CVE-2026-76844`, `transformers`, `Pillow`, `libxml2`, `util-linux`...) được suppress theo chính sách chấp nhận rủi ro có thời hạn `SEC-REG-6.4.4A` (hạn rà soát **2026-12-01**) | Đây là chấp nhận rủi ro có thời hạn, **không đồng nghĩa đã vá/loại bỏ lỗ hổng upstream**; không cho phép suppress ngoài phạm vi đăng ký | **PASS HOSTED (WITH GOVERNED EXCEPTIONS)** |

---

### Step 5.2c — Pure Deterministic Causal Projection Engine & Hydration (IMPLEMENTED — PENDING FINAL GATE REVIEW)

| Claim | Source File | Test / Gate | Commit SHA | Hosted Run | Evidence Type | What This Does NOT Prove | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **C1: Pure Deterministic `Resolve(Shadow, Pending, Grace)` & Permutation Invariance** | `apps/web/src/lib/sync/causal-projection-engine.ts` | Section 1 (`causal-projection-engine.spec.ts`) | `Step 5.2c Head` | Pending Final Gate Review | Shuffled shadow/pending arrays produce identical projection output; cross-chapter & `forceRewind` progress rules; `needsHydration` + catalog enrichment | Không chứng minh tự động gọi API lấy catalog metadata khi thiếu mạng (Step 7 / UI layer) | **IMPLEMENTED — PENDING FINAL GATE REVIEW** |
| **C2: Dual-Layer Tombstone & Causal Epoch Suppression (Rev 2.2 P0-03, P0-05)** | `apps/web/src/lib/sync/causal-projection-engine.ts` | Section 2 & Step 5.2b integration (`causal-projection-engine.spec.ts`) | `Step 5.2c Head` | Pending Final Gate Review | Chặn HISTORY shadow có `epoch < effective`, giữ lại `4 === 4`; chặn pending thiếu epoch có `baseServerRevision < tombstoneRevision`; chống phục sinh bookmark/progress; lọc chronological HISTORY DELETE | Không thay thế server-side epoch check trên Core API (đã khóa tại Phase 5.1) | **IMPLEMENTED — PENDING FINAL GATE REVIEW** |
| **C3: Bounded Post-Receipt Grace Window (Rev 2.2 P0-04)** | `apps/web/src/lib/sync/causal-projection-engine.ts`, `apps/web/src/lib/sync/projection-hydrator.ts` | Section 3 (`causal-projection-engine.spec.ts`) | `Step 5.2c Head` | Pending Final Gate Review | Giữ trạng thái optimistic sau receipt `APPLIED` để tránh flicker và tự giải phóng khi `syncedServerRevision >= assignedRevision` hoặc hết TTL `5000ms` | Không tồn tại qua F5 reload (cố ý in-session để reload chỉ dựa trên IndexedDB) | **IMPLEMENTED — PENDING FINAL GATE REVIEW** |
| **C4: Authoritative Fallback, Monotonic Merge & Canonical Keys (ST-02, ST-04, ST-12)** | `apps/web/src/lib/sync/causal-projection-engine.ts`, `apps/web/src/lib/sync/projection-hydrator.ts` | ST-02, ST-04, ST-12 (`causal-projection-engine.spec.ts`) | `Step 5.2c Head` | Pending Final Gate Review | Thu hồi pending bị từ chối khôi phục hiển thị Shadow; giữ `max(progress)` khi pending nhỏ hơn shadow; chuẩn hóa key `chapterId` / `storyId` / `'all'` / UUID sentinel với `${storyId}:${chapterId}` | Không kiểm thử network receipt arrival từ WebSocket/HTTP (Step 5.2d) | **IMPLEMENTED — PENDING FINAL GATE REVIEW** |
| **C5: Step 4 Isolation & Multi-Scope Tenant Isolation (ST-03, ST-06)** | `apps/web/src/lib/sync/projection-hydrator.ts`, `apps/web/src/lib/sync/causal-projection-engine.ts` | ST-03, ST-06 (`causal-projection-engine.spec.ts`) | `Step 5.2c Head` | Pending Final Gate Review | `recordReadingSessionWithMutation` không chạm `sync_authoritative_replicas`; `account-1`, `account-2`, `guest-1` hoàn toàn tách biệt cả epoch và mode | `fake-indexeddb` mô phỏng IDB v4 trong Node test runner | **IMPLEMENTED — PENDING FINAL GATE REVIEW** |
| **C6: Reload Determinism & Fail-Closed Degraded Mode (ST-13)** | `apps/web/src/lib/sync/projection-hydrator.ts` | ST-13, Degraded Mode, SSR Guard (`causal-projection-engine.spec.ts`) | `Step 5.2c Head` | Pending Final Gate Review | Đóng client & khởi tạo `SyncProjectionHydrator` mới đọc 1 IDB transaction qua 7 stores ra kết quả y hệt không phụ thuộc RAM grace/events; fail-closed về `DEGRADED_COMPATIBILITY` khi `baseline !== 'READY'`; ném `IndexedDbUnavailableError` trên SSR | Chưa gắn vào live React hooks / Coordinator startup (Step 5.2d / Step 7) | **IMPLEMENTED — PENDING FINAL GATE REVIEW** |
| **C7: Atomic Materialization & Concurrent User Write Preservation (ST-15)** | `apps/web/src/lib/sync/projection-hydrator.ts` | ST-15 (`causal-projection-engine.spec.ts`) | `Step 5.2c Head` | Pending Final Gate Review | Đọc lại `pending_mutations` + legacy stores trong 1 `readwrite` transaction duy nhất và race với `recordReadingSessionWithMutation` / `putPreferenceWithMutation`: 100% bảo toàn pending local write & xóa sạch item bị delete/stale | Không ngăn chặn lỗi phần cứng ổ đĩa ngoài giao dịch IndexedDB | **IMPLEMENTED — PENDING FINAL GATE REVIEW** |
| **C8: Regression Suite, Frozen Files Audit & Production Build** | `apps/web` | 19/19 projection tests, 57/57 suites (846/846 tests), `tsc --noEmit`, `eslint`, `next build` | `Step 5.2c Head` | Pending Final Gate Review | `git diff` xác nhận 0 thay đổi trên `mutation-queue.ts` (FROZEN) & `indexed-db-client.ts` (Step 5.2b FROZEN); toàn bộ Web test/lint/typecheck/build PASS | Chưa bao gồm Step 5.2d Network Delta Pull & Step 6 Snapshot Bootstrap Finalizer | **IMPLEMENTED — PENDING FINAL GATE REVIEW** |

---

### Security Remediation Only (Post-Step 5.2c / PR #210 — APPROVED & MERGED on `main`)

| Claim | Source File | Test / Gate | Commit SHA | Hosted Run | Evidence Type | What This Does NOT Prove | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **SR-01: Core API & AI Worker Base OS Vulnerability Patching** | `services/api/Dockerfile`, `services/ai-worker/Dockerfile` | Raw Trivy JSON + Trivy Scan `exit-code: '1'` | `933002d` / `4575760` | `#42571464548` (Post-Merge `main`) | `apk upgrade --no-cache` trên Core API (`musl` `1.2.5-r23` vá `CVE-2026-107891`; `zlib` `1.3.2-r1` vá `CVE-2026-85091`) và `apt-get upgrade -y` trên AI Worker (`zlib1g` `1:1.3.dfsg+really1.3.1-1+deb13u1` vá `CVE-2026-85091` & `CVE-2026-76844`) | Không chứng minh 0 CVE trong các thư viện Python ML/Node bắc cầu còn nằm trong ngoại lệ `SEC-REG-6.4.4A` | **PASS HOSTED** |
| **SR-02: Observability Image Upgrades & Strict Digest Alignment** | `deploy/docker-compose.observability.yml`, `.github/workflows/ci-cd.yml`, `deploy/validate-compose-topology.py`, `deploy/test-acceptance-gate-6-4-4.ts` | `validate-compose-topology.py --test` (17/17 PASS) & `--stdin` (PASS) | `933002d` / `4575760` | `#42571464548` (Post-Merge `main`) | Nâng `prom/prometheus:v3.16.0` (`sha256:e0498764...`) & `grafana/grafana:13.3.0` (`sha256:488984b7...`); gỡ 5 scoped entries khỏi `prometheus` và 10 scoped entries khỏi `grafana`; vá luôn `CVE-2026-107891` & `CVE-2026-85091` trên Grafana Alpine `3.24.3` | Job VPS chỉ xác thực topology & compose manifests vì `VPS_SSH_HOST` / `VPS_SSH_KEY` chưa cấu hình (không phải live VPS SSH rollout) | **PASS HOSTED** |
| **SR-03: Governed Exception Register, Package Binding & P2 Metric Alignment** | `deploy/security/trivy/*.trivyignore`, `deploy/security/trivy-exception-register.md`, `.trivyignore` | `validate-trivy-exceptions.py --test --enforce-reports` (12/12 PASS) & Trivy 5/5 PASS | `933002d` / `4575760` | `#42571464548` (Post-Merge `main`) | Binding 100% raw findings trên 5 images (`ai-worker` 76/76, `api` 18/18, `grafana` 54/54, `nginx` 0/0, `prometheus` 2/2); gỡ tổng cộng **18** mục scoped lịch sử (`2 api + 1 ai-worker + 5 prometheus + 10 grafana`, cộng 2 CVE mới vá trực tiếp `CVE-2026-107891` & `CVE-2026-85091`); hiện có **102** scoped entries = **99 unique security advisory IDs** (**98 CVE IDs + 1 GHSA ID `GHSA-5p4m-2wfm-xmqj`**), hết hạn **2026-12-01** (`SEC-REG-6.4.4A`) | Đây là ngoại lệ có thời hạn (không phải xóa triệt để rủi ro upstream). **P1 Backlog:** cần bỏ phụ thuộc `.trivyignore` ở root hoặc bắt buộc dùng `--ignorefile` / `trivy.yaml` tường minh khi quét CLI thủ công tại root | **PASS HOSTED (WITH GOVERNED EXCEPTIONS)** |
| **SR-04: Strict Source Isolation & Post-Merge Hosted CI 7/7 Verification** | `.github/workflows/ci-cd.yml` (0 thay đổi trong `apps/web/`, `packages/shared/`, `apps/mobile/`, `services/*/src`) | Hosted GitHub Actions Run `#42571464548` (**7/7 Jobs `SUCCESS`**) | `4575760` | `#42571464548` (Post-Merge `main`) | Diff PR `#210` chỉ gồm 12 tệp Docker/CI/observability/governance; Web (`eslint`/`tsc`/`build` + 57/57 Vitest `846/846` + Playwright `31/31`), API (Unit `50/50` `606 passed, 1 skipped` + E2E `23/23` `309/309`), Mobile (`flutter analyze` 0 + `500/500`), AI Worker (`323/323`), Security (`0` verified secrets, `12/12`), Docker Trivy 5/5 PASS, VPS Topology `17/17` PASS | Không tự động phê duyệt/đóng Step 5.2c; mã nguồn `causal-projection-engine.ts` và `projection-hydrator.ts` vẫn giữ nguyên **`IMPLEMENTED — PENDING FINAL GATE REVIEW`** để nghiệm thu riêng | **PASS HOSTED** |

---

### Step 4a.1 Archive (Historical Reference)

| Claim | Source File | Test / Gate | Commit SHA | Hosted Run | Evidence Type | What This Does NOT Prove | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **C1: Generation-Safe Batch Release (P0-09)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-14, RT-15 (`mutation-queue.spec.ts`) | `8aad88b` | #41071077444 (Blocked) | Interleaving & Concurrency Test (fake-indexeddb) | Không chứng minh hành vi Web Locks đa tab (đã kiểm chứng ở Step 3) | **PASS LOCAL** |
| **C2: Same-Generation Batch Ownership (P0-09)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-16 (`mutation-queue.spec.ts`) | `8aad88b` | #41071077444 (Blocked) | Unit & Concurrency Test | Không chứng minh exactly-once delivery qua mạng vật lý | **PASS LOCAL** |
| **C3: Stale Receipt Rejection (P0-09B)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-14, RT-16, RT-23 (`mutation-queue.spec.ts`) | `8aad88b` | #41071077444 (Blocked) | Async Interleaving Test | Không chứng minh hành vi crash recovery của OS khi process bị kill đột ngột | **PASS LOCAL** |
| **C4: Complete Pre-Transaction Admission (P0-10)** | `apps/web/src/lib/storage/indexed-db-client.ts` | RT-17, RT-18, RT-19, RT-20 (`mutation-queue.spec.ts`) | `8aad88b` | #41071077444 (Blocked) | Interleaving Test (delayed getDatabase) | Không thể rollback transaction đã commit trước khi authority bị thu hồi | **PASS LOCAL** |
| **C5: Real Transaction Abort Rollback (P0-10)** | `apps/web/src/lib/storage/indexed-db-client.ts` | RT-21 (`mutation-queue.spec.ts`) | `8aad88b` | #41071077444 (Blocked) | Real IDB Transaction Abort Test (`tx.abort()`) | Không chứng minh lỗi hỏng phần cứng đĩa vật lý (hardware corruption) | **PASS LOCAL** |
| **C6: Post-Commit Callback Safety (P0-10)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-22 (`mutation-queue.spec.ts`) | `8aad88b` | #41071077444 (Blocked) | Continuation Callback Unit Test | Không đảo ngược dữ liệu đã commit vào IndexedDB nếu authority thu hồi sau commit | **PASS LOCAL** |
| **C7: Duplicate / Late Callback Safety** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-23 (`mutation-queue.spec.ts`) | `8aad88b` | #41071077444 (Blocked) | Idempotency & Invariance Test | Không thay thế việc server-side deduplication | **PASS LOCAL** |
| **C8: Step 4a Regression Preservation** | `apps/web/src/test/mutation-queue.spec.ts` | RT-01 đến RT-13, RT-24 (54/54 PASS) | `8aad88b` | #41071077444 (Blocked) | Full Mutation Queue Vitest Suite | Chưa tích hợp toàn diện với Step 5 Delta Pull Reconciler | **PASS LOCAL** |
| **C9: Sync Regression Suite** | `apps/web/src/test/*sync*.spec.ts` | Gate B: Migration (18), Leader (13), Queue (54) - 85/85 PASS | `8aad88b` | #41071077444 (Blocked) | Vitest Integration Suite | Chưa kiểm thử E2E Playwright trên hosted cluster | **PASS LOCAL** |
| **C10: Entire Web Regression Suite** | `apps/web/src/test/**/*.spec.ts*` | Gate C: 54 suites, 750 tests PASS | `8aad88b` | #41071077444 (Blocked) | Full Web Application Test Run | Không đảm bảo 100% không có UI layout visual regression trên Safari cũ | **PASS LOCAL** |
| **C11: Strict TypeScript Conformance** | `apps/web` | Gate D: `tsc --noEmit` (0 errors) | `8aad88b` | #41071077444 (Blocked) | Static Typecheck Compilation | Không bắt được runtime unexpected undefined do JSON parse bừa bãi | **PASS LOCAL** |
| **C12: Production Bundle Build** | `apps/web` | Gate E: `next build` (Turbopack, Next 16.3.3) | `8aad88b` | #41071077444 (Blocked) | Production Bundle Compilation | Chưa chứng minh runtime server memory leak dưới tải cao | **PASS LOCAL** |
| **C13: Hosted CI / GitHub Actions Status** | `.github/workflows/ci.yml` | GitHub Actions push pipeline | `8aad88b` | #41071077444 (Blocked) | Hosted CI Infrastructure | **Bị chặn bởi giới hạn chi tiêu GitHub Actions (Account spending limit reached). Không phải lỗi mã nguồn.** | **PENDING EXTERNAL BLOCKER** |
