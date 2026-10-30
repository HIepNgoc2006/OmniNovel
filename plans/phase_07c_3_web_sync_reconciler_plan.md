# 📋 Kế Hoạch Triển Khai Task 7C.3 — Web Client Sync Reconciler (`apps/web`)

> **Trạng thái:** `[/] Đang Triển Khai (APPROVED WITH AMENDMENTS)`  
> **Cơ sở pháp lý / Baseline nghiệm thu:** Task 7C.2 FROZEN CLEAN tại baseline `4e9c4dbfb96a6b7957090d8a306485333014c550` (Hosted CI Run #40701295336).  
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
    ├── mutation-queue.ts             <-- [Bước 4 - MỚI] Pending mutation queue, atomic enqueue & quarantine
    ├── delta-pull-reconciler.ts      <-- [Bước 5 - MỚI] Kéo /sync/changes, paginated checkpoint & atomic apply
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
- [ ] **Bước 5:** Cài đặt `apps/web/src/lib/sync/delta-pull-reconciler.ts` kéo changes, paginated checkpoint (`nextRevision` khi `hasMore=true`, `currentServerRevision` khi `hasMore=false`) và áp dụng checkpoint nguyên tử.
- [ ] **Bước 6:** Cài đặt `apps/web/src/lib/sync/snapshot-reconciler.ts` xử lý Safe 410 Gone Full Resync với staging, hủy bỏ staging khi gặp 409 snapshot invalidation.
- [ ] **Bước 7:** Tích hợp `apps/web/src/lib/sync/web-sync-coordinator.ts` và gắn kết với Auth/Identity/Reader hooks.
- [ ] **Bước 8:** Chạy kiểm thử toàn diện (Vitest, Next.js build), xác minh các kịch bản nghiệm thu và đẩy Git đồng bộ.

---

## 6. Hồ Sơ Bằng Chứng Nghiệm Thu Step 4a (Evidence Matrix)

| Claim | Source File | Test / Gate | Commit SHA | Hosted Run | Evidence Type | What This Does NOT Prove | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **C1: Atomic Retry & Quarantine Decision (P1-01)** | `apps/web/src/lib/storage/indexed-db-client.ts` | RT-01 (`mutation-queue.spec.ts`) | Current Commit | #41040380433 (Blocked) | Unit & Concurrency Test (fake-indexeddb) | Không chứng minh hành vi transaction lock trên WebKit/Safari nếu driver vi phạm spec IDB | **PASS LOCAL** |
| **C2: Pre-Transaction Admission Guard (P0-07)** | `apps/web/src/lib/storage/indexed-db-client.ts` | RT-05, RT-06 (`mutation-queue.spec.ts`) | Current Commit | #41040380433 (Blocked) | Interleaving Test (delayed getDatabase) | Không chứng minh crash recovery của OS khi transaction đang ở trạng thái in-flight | **PASS LOCAL** |
| **C3: Authority Assertions across Async Boundaries (P0-07)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-03, RT-04, RT-07 (`mutation-queue.spec.ts`) | Current Commit | #41040380433 (Blocked) | Async State Machine Unit Test | Chưa kiểm thử luồng thực tế của Step 5 Delta Pull Reconciler | **PASS LOCAL** |
| **C4: In-Flight Generation Isolation (P0-08)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-02, RT-08 (`mutation-queue.spec.ts`) | Current Commit | #41040380433 (Blocked) | Concurrency Matrix Test ($A \to B \to A$) | Không chứng minh đồng bộ nhiều tab (đã được bao bọc bởi Web Locks ở Step 3) | **PASS LOCAL** |
| **C5: Non-destructive Abort on Failure (P0-07)** | `apps/web/src/lib/sync/mutation-queue.ts` | RT-09 (`mutation-queue.spec.ts`) | Current Commit | #41040380433 (Blocked) | State Invariance Test | Không thay thế việc manual testing trên mobile browser | **PASS LOCAL** |
| **C6: Deterministic Concurrency Suite (RT-01 to RT-13)** | `apps/web/src/test/mutation-queue.spec.ts` | Gate A: `mutation-queue.spec.ts` (44/44 PASS) | Current Commit | #41040380433 (Blocked) | Vitest Test Suite Execution | Không chứng minh network real jitter trên môi trường production | **PASS LOCAL** |
| **C7: Sync Suites Regression Suite** | `apps/web/src/test/*sync*.spec.ts` | Gate B: Migration (18), Leader (13), Queue (44) - 75/75 PASS | Current Commit | #41040380433 (Blocked) | Vitest Integration Suite | Chưa tích hợp toàn diện với Step 5 & Step 6 reconcilers | **PASS LOCAL** |
| **C8: Entire Web Regression Suite** | `apps/web/src/test/**/*.spec.ts*` | Gate C: 54 suites, 740 tests PASS | Current Commit | #41040380433 (Blocked) | Full Web Application Test Run | Chưa kiểm thử E2E Playwright trên hosted cluster | **PASS LOCAL** |
| **C9: Strict TypeScript Conformance** | `apps/web` | Gate D: `tsc --noEmit` (0 errors) | Current Commit | #41040380433 (Blocked) | Static Typecheck Compilation | Không bắt được runtime unexpected undefined do JSON parse bừa bãi | **PASS LOCAL** |
| **C10: Production Bundle Build** | `apps/web` | Gate E: `next build` (Turbopack, Next 16.3.3) | Current Commit | #41040380433 (Blocked) | Production Bundle Compilation | Chưa chứng minh runtime server memory leak dưới tải cao | **PASS LOCAL** |
| **C11: Hosted CI / GitHub Actions Status** | `.github/workflows/ci.yml` | GitHub Actions push pipeline | Current Commit | Pending External Blocker | Hosted CI Infrastructure | **Bị chặn bởi giới hạn chi tiêu GitHub Actions (Account spending limit reached). Không phải lỗi mã nguồn.** | **PENDING EXTERNAL BLOCKER** |
