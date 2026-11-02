# 🏛️ Kiến Trúc Coexistence Revision 2.1: Tombstone-Safe Shadow, Bootstrap Baseline & Causal Projection Contract
## Đề Xuất Hoàn Thiện Tầng Lưu Trữ Client-Side Web Sync (`apps/web` — Phase 5.2)

> **Tài liệu:** Thiết kế Kiến trúc Đồng Bộ Lưu Trữ Cục Bộ (Storage Coexistence RFC — Revision 2.1)  
> **Trạng thái:** `Đã Khắc Phục Toàn Diện 5 Điểm P0 & P1 (READY FOR CONTRACT GATE APPROVAL)`  
> **Cơ sở pháp lý:** Bản hoàn thiện tiếp thu chỉ đạo từ Gate Review Phase 5.1 & Storage Coexistence Revision 2 (Commit `647caa5`).  
> **Mục tiêu:** Khóa toàn diện cơ chế Tombstone Suppression, Baseline Bootstrap, Causal Entity Mapping, Recovery độc lập RAM callbacks, Checkpoint OCC; bảo toàn 100% Step 4 Frozen Baseline (`mutation-queue.ts`).

---

## 1. Tổng Quan & Phân Tích Các Vấn Đề Cốt Lõi Được Giải Quyết

Trong đợt Gate Review trước, kiến trúc **Durable Authoritative Shadow + Optimistic Projection** đã được chấp thuận về mặt nguyên lý (`ACCEPTED IN PRINCIPLE`). Tuy nhiên, để đảm bảo hệ thống có thể triển khai thực tế mà không phát sinh bất kỳ kịch bản sai lệch dữ liệu nào giữa Shadow và UI, bản **Revision 2.1** giải quyết triệt để 5 lỗ hổng P0 và các điểm tinh chỉnh P1:

| Mã vấn đề | Bản chất kỹ thuật & Rủi ro | Giải pháp kỹ thuật tại Revision 2.1 |
| :--- | :--- | :--- |
| **P0-01** | **HISTORY DELETE phạm vi Story/Global không xóa chapter shadows:** Shadow lưu `entityKey = ${storyId}:${chapterId}`, khi server phát DELETE truyện hoặc global, nếu chỉ lưu tombstone thì các chapter shadows cũ vẫn còn, projection đọc ra gây sống lại lịch sử đã xóa. | **Cascading Shadow Eviction & Dual-Layer Tombstone Suppression:** Xóa nguyên tử toàn bộ chapter shadows thuộc phạm vi trong transaction của Delta Pull; đồng thời áp dụng suppression guard 2 lớp (Global effective epoch + Story tombstone) ở mọi đường đọc projection. |
| **P0-02** | **Migration v3 $\to$ v4 tạo Shadow rỗng với Checkpoint cũ $> 0$:** Nếu checkpoint đang ở `"150"`, Shadow mới rỗng, Delta Pull kéo từ `"151"` bỏ qua dữ liệu cũ, khiến projection kết luận sai là người dùng chưa có dữ liệu. | **Persistent Baseline Lifecycle (`UNINITIALIZED` $\to$ `READY`):** Gắn cờ trạng thái bootstrap trong `sync_meta`. Khi checkpoint $> 0$ và Shadow rỗng, kích hoạt quy trình kéo Snapshot Baseline (Step 6) trước khi cấp quyền `READY`. Trong thời gian bootstrap, projection đọc ở chế độ tương thích an toàn từ legacy stores. |
| **P0-03** | **Lệch định dạng Entity Key & So sánh thứ tự chương bằng UUID:** `LocalPendingMutation.entityId` không khớp `${storyId}:${chapterId}`; UUID chương không thể dùng để so sánh tiến trình đọc. | **Canonical Entity Key Extractor & Causal Intent Rule:** Chuẩn hóa hàm trích xuất khóa theo domain; phân định rõ: cùng chapter thì so sánh monotonic percentage; khác chapter thì tôn trọng ý chí thao tác trực tiếp của người dùng (user intent) khi mutation đang pending, tự động hoàn nguyên về Shadow nếu server từ chối mà không cần đoán thứ tự UUID. |
| **P0-04** | **Phục hồi phụ thuộc RAM callbacks (`onProjectionDirty`):** Nếu crash/reload hoặc callback không được đăng ký, projection không thể cập nhật. | **Deterministic Durable Derivation:** Projection là hàm thuần túy đọc trực tiếp từ IndexedDB bền vững (`sync_authoritative_replicas` + `pending_mutations`). RAM events chỉ là tín hiệu tối ưu độ trễ UI re-render, không phải điều kiện toàn vẹn dữ liệu. |
| **P0-05** | **Thiếu OCC Checkpoint Guard & Epoch Tracking không an toàn:** Hai pull đồng quy có thể ghi đè checkpoint; gán epoch bừa bãi cho mọi delta làm sai lệch logic epoch server. | **Atomic Precondition OCC & Domain Epoch Governance:** Ghi checkpoint bắt buộc kiểm tra `expectedRevision === currentRevision`. Phân biệt nghiêm ngặt: `HISTORY DELETE` bắt buộc mang server epoch mới; `HISTORY UPSERT` giữ nguyên epoch hiện tại; fail-closed nếu DELETE thiếu epoch. |

---

## 2. Kiến Trúc 4 Tầng Toàn Diện (Durable & Orthogonal Architecture)

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   UI / Reader Components                                │
└───────────────────────────────────────────▲─────────────────────────────────────────────┘
                                            │ Reads Projected State
┌───────────────────────────────────────────┴─────────────────────────────────────────────┐
│                 TẦNG 3: UI PROJECTION ENGINE (Materialized / Derived)                   │
│   ProjectedState = PureCausalResolve(AuthoritativeShadow, DurablePendingMutations)      │
│   • Phục hồi 100% từ IndexedDB sau F5/Reload (Không phụ thuộc RAM event)                │
│   • Dual-Layer Tombstone & Epoch Suppression Guard                                      │
└───────────────────▲─────────────────────────────────────────────────▲───────────────────┘
                    │ Reads Canonical Truth                           │ Reads Optimistic Intent
┌───────────────────┴─────────────────────────┐   ┌───────────────────┴───────────────────┐
│     TẦNG 1: AUTHORITATIVE SHADOW            │   │        TẦNG 2: PENDING QUEUE          │
│ Store: sync_authoritative_replicas          │   │ Store: pending_mutations              │
│ Key: [ownerScope, domain, entityKey]        │   │ Key: [ownerScope, mutationId]         │
│ • Raw server payload, revision, epoch       │   │ • Step 4 Quản lý (FROZEN CLEAN)       │
│ • CHỈ GHI BỞI: Delta Pull & Snapshot Triage │   │ • CHỈ GHI BỞI: Local User Actions     │
│ • Checkpoint OCC Guard & Cascading Eviction │   │ • Bị xóa khi APPLIED/REJECTED_TOMB    │
└───────────────────▲─────────────────────────┘   └───────────────────▲───────────────────┘
                    │ Single Atomic Transaction                       │ Atomic Enqueue
┌───────────────────┴─────────────────────────┐   ┌───────────────────┴───────────────────┐
│      Step 5: Delta Pull Reconciler          │   │      Step 4: Local Mutation Writer    │
│      Step 6: Snapshot Triage Engine         │   │  recordReadingSessionWithMutation()   │
└─────────────────────────────────────────────┘   └───────────────────────────────────────┘
```

---

## 3. Khóa Lỗ Hổng P0-01: HISTORY DELETE Scope, Cascading Eviction & Dual-Layer Suppression

### 3.1 Bản chất sự khác biệt giữa Server Contract và Shadow Key
- Core API phát 2 loại `HISTORY DELETE`:
  1. **Story-wide DELETE:** `entityId = storyId`, payload = `{ storyId, epoch: newEpoch }`.
  2. **Global DELETE:** `entityId = '00000000-0000-0000-0000-000000000000'` (hoặc alias `'all'`), payload = `{ epoch: newEpoch }`.
- Trong khi đó, các bản ghi đọc lịch sử của từng chương trong `sync_authoritative_replicas` có khóa:
  `entityKey = ${storyId}:${chapterId}`.

### 3.2 Quy Trình Cascading Eviction Tại Thời Điểm Delta Pull Ghi Transaction
Khi Delta Pull nhận delta `domain === 'HISTORY'` và `operation === 'DELETE'`:
Trong **cùng 1 transaction `readwrite`** trên `['sync_authoritative_replicas', 'sync_meta']`:

1. **Nếu là Story-wide DELETE (`entityId === storyId`):**
   - **Xóa toàn bộ chapter shadows:** Quét store `sync_authoritative_replicas` trong phạm vi `(ownerScope, domain='HISTORY')` và xóa mọi bản ghi có `entityKey` bắt đầu bằng `${storyId}:`.
   - **Xóa progress shadow tương ứng:** Xóa bản ghi `(ownerScope, domain='PROGRESS', entityKey=storyId)` (bởi vì trên Server, xóa lịch sử truyện đồng thời xóa `reading_progress`).
   - **Ghi Story Tombstone Shadow:** Ghi bản ghi tombstone:
     ```typescript
     {
       ownerScope,
       domain: SyncDomain.HISTORY,
       entityKey: storyId,
       serverRevision: delta.revision,
       epoch: delta.payload.epoch, // Server epoch mới
       payload: { storyId, epoch: delta.payload.epoch },
       isDeleted: true,
       updatedAt: Date.now()
     }
     ```
2. **Nếu là Global DELETE (`entityId === UUID_SENTINEL || entityId === 'all'`):**
   - **Xóa toàn bộ:** Quét và xóa TOÀN BỘ bản ghi trong `sync_authoritative_replicas` có `(ownerScope, domain='HISTORY')` và `(ownerScope, domain='PROGRESS')`.
   - **Ghi Global Tombstone Shadow:** Ghi bản ghi sentinel:
     ```typescript
     {
       ownerScope,
       domain: SyncDomain.HISTORY,
       entityKey: '00000000-0000-0000-0000-000000000000',
       serverRevision: delta.revision,
       epoch: delta.payload.epoch,
       payload: { epoch: delta.payload.epoch },
       isDeleted: true,
       updatedAt: Date.now()
     }
     ```
   - **Cập nhật Global Epoch:** Ghi vào `sync_meta`:
     `effectiveHistoryEpoch = delta.payload.epoch`.
3. **Tính cô lập tuyệt đối:** Toàn bộ thao tác chỉ tác động trên `ownerScope` hiện tại. Không bao giờ ảnh hưởng đến tài khoản khác hoặc guest khác.

### 3.3 Cơ Chế Dual-Layer Suppression Ở Đường Đọc Projection
Để đảm bảo an toàn phòng thủ theo chiều sâu (Defense-in-Depth), khi Projection Engine đọc bất kỳ bản ghi lịch sử đọc nào:
- **Lớp 1 (Global Tombstone Check):** Kiểm tra `sync_meta.effectiveHistoryEpoch`. Nếu bản ghi có `epoch < effectiveHistoryEpoch` $\implies$ Tự động bị coi là đã xóa (`null`).
- **Lớp 2 (Story Tombstone Check):** Đọc tombstone của story tương ứng `(ownerScope, 'HISTORY', storyId)`. Nếu tồn tại và `record.serverRevision <= tombstone.serverRevision` $\implies$ Tự động bị coi là đã xóa (`null`).

---

## 4. Khóa Lỗ Hổng P0-02: Migration v3 $\to$ v4, Baseline Lifecycle & Snapshot Bootstrap

### 4.1 Bổ Sung Trạng Thái Baseline Vào `sync_meta`

```typescript
export type AuthoritativeBaselineStatus = 
  | 'UNINITIALIZED' // Shadow rỗng, cần bootstrap trước khi tin cậy
  | 'BOOTSTRAPPING'  // Đang trong tiến trình kéo snapshot nạp shadow
  | 'READY';         // Shadow đã hoàn chỉnh, projection kích hoạt đầy đủ
```

Bảng `sync_meta` bổ sung trường: `authoritativeBaselineStatus: AuthoritativeBaselineStatus`.

### 4.2 Quy Tắc Chuyển Đổi Khi Upgrade Schema (v3 $\to$ v4):
Trong sự kiện `onupgradeneeded` (`DB_VERSION = 4`):
1. Tạo object store `sync_authoritative_replicas` với khóa `['ownerScope', 'domain', 'entityKey']`.
2. Khởi tạo trạng thái baseline:
   - Nếu `sync_meta.lastSyncedServerRevision === '0'` (chưa từng sync): Gán `authoritativeBaselineStatus = 'READY'`.
   - Nếu `sync_meta.lastSyncedServerRevision > '0'` (đã sync trước đây ở v3): Bắt buộc gán `authoritativeBaselineStatus = 'UNINITIALIZED'`. **Tuyệt đối không coi Shadow rỗng là hoàn chỉnh!**

### 4.3 Quy Trình Bootstrap Baseline Khi Khởi Động Reconciler:
Khi Web Sync Coordinator khởi động cho một `ownerScope`:
1. Đọc `sync_meta`. Nếu `authoritativeBaselineStatus === 'UNINITIALIZED'`:
   - Chuyển trạng thái sang `BOOTSTRAPPING`.
   - **Trong thời gian này:** Projection Engine hoạt động ở **Degraded Compatibility Mode**:
     - Đọc dữ liệu trực tiếp từ legacy local stores (`bookmarks`, `progress`, `history`, `preferences`).
     - Người dùng đọc truyện, tạo bookmark bình thường; Step 4 tiếp tục ghi nhận `pending_mutations` vào hàng đợi mà không bị gián đoạn.
2. **Kích hoạt Snapshot Bootstrap (Step 6 Protocol):**
   - Gọi `GET /sync/snapshot` với phân trang keyset đầy đủ qua cả 4 domain.
   - Điền toàn bộ dữ liệu authoritative từ Snapshot vào `sync_authoritative_replicas`.
   - Ghi nhận `lastSyncedServerRevision = snapshot.snapshotRevision`.
   - Ghi nhận `effectiveHistoryEpoch = snapshot.effectiveHistoryEpoch`.
   - Cập nhật `authoritativeBaselineStatus = 'READY'` trong cùng transaction commit snapshot cuối cùng.
3. Khi đã chuyển sang `READY`: Projection Engine chính thức chuyển sang chế độ chuẩn hóa: `CausalResolve(Shadow, PendingMutations)`.
4. **Bất biến:** CẤM tuyệt đối việc tự ý copy dữ liệu từ legacy stores sang Shadow rồi gán nhãn đó là "Server Truth".

---

## 5. Khóa Lỗ Hổng P0-03: Domain-Aware Causal Projection Contract & Entity Mapping

### 5.1 Bảng Ánh Xạ Khóa Chuẩn Hóa Giữa Pending Mutation và Shadow

| Domain | Định dạng Khóa Shadow (`entityKey`) | Trường trích xuất từ `LocalPendingMutation` | Helper Ánh Xạ |
| :--- | :--- | :--- | :--- |
| `PROGRESS` | `storyId` | `mutation.entityId` (luôn là `storyId`) | `mutation.entityId` |
| `HISTORY` | `${storyId}:${chapterId}` | `payload.storyId` và `payload.chapterId` (hoặc `mutation.entityId`) | `getCanonicalHistoryKey(mutation)` |
| `HISTORY` *(Tombstone)* | `storyId` hoặc `00000000-0000-0000-0000-000000000000` | `mutation.entityId` | `mutation.entityId` |
| `BOOKMARK` | `storyId` | `mutation.entityId` | `mutation.entityId` |
| `PREFERENCE` | `key` | `mutation.entityId` | `mutation.entityId` |

### 5.2 Helper Trích Xuất Khóa Chuẩn Hóa:
```typescript
export function getCanonicalEntityKey(
  domain: SyncDomain,
  entityId: string,
  payload?: Record<string, any>
): string {
  if (domain === SyncDomain.HISTORY) {
    if (entityId === 'all' || entityId === '00000000-0000-0000-0000-000000000000') {
      return '00000000-0000-0000-0000-000000000000';
    }
    if (payload?.storyId && payload?.chapterId) {
      return `${payload.storyId}:${payload.chapterId}`;
    }
  }
  return entityId;
}
```

### 5.3 Quy Tắc Phân Giải Causal Đọc Tiến Trình (Không So Sánh UUID Chương):
Tuyệt đối không so sánh chuỗi UUID của `chapterId` để đoán thứ tự chương.
Khi phân giải `PROGRESS`:
1. Nếu có `AuthoritativeShadow` và có `PendingMutation` trong hàng đợi:
   - **Kịch bản A (Cùng Chapter):** `shadow.chapterId === pending.payload.chapterId`:
     $$\text{progressPercentage} = \max(\text{shadow.progressPercentage}, \text{pending.payload.progressPercentage})$$
     Lấy vị trí cuộn / số trang tương ứng với phần trăm lớn hơn.
   - **Kịch bản B (Khác Chapter):**
     - Mutation trong `pending_mutations` phản ánh **ý chí thao tác trực tiếp của người dùng tại thiết bị hiện tại (active user intent)**.
     - Chừng nào mutation còn nằm trong hàng đợi (chưa bị Server từ chối), Projection **ưu tiên hiển thị trạng thái của Pending Mutation** (chương người dùng đang đọc).
     - **Cơ chế an toàn:** Nếu sau đó Server từ chối mutation (do xung đột epoch, tombstone hoặc server đã ở chương mới hơn): Step 4 sẽ evict mutation khỏi pending queue $\to$ Projection tự động hoàn nguyên về Authoritative Shadow mà không cần phải so sánh thứ tự UUID chương!

---

## 6. Khóa Lỗ Hổng P0-04: Phục Hồi Sau Receipt Độc Lập Khỏi RAM Event Callbacks

### 6.1 Bản Chất: Projection Là Hàm Thuần Túy Trên Dữ Liệu Bền Vững (Pure Function)

$$\text{ProjectedState} = \mathcal{F}_{\text{causal}}\Big(\text{IDB}(\texttt{sync\_authoritative\_replicas}),\; \text{IDB}(\texttt{pending\_mutations})\Big)$$

- Cả `sync_authoritative_replicas` và `pending_mutations` đều được lưu trữ bền vững trên đĩa thông qua IndexedDB.
- Khi Step 4 nhận terminal receipt từ Server:
  - `APPLIED` $\implies$ Step 4 xóa mutation khỏi `pending_mutations` trong transaction IndexedDB.
  - `REJECTED_TOMBSTONE` $\implies$ Step 4 gọi `evictReplicaAndRemovePending` xóa mutation trong transaction IndexedDB.
  - `REJECTED_STALE` $\implies$ Step 4 chuyển mutation sang `quarantined_mutations` trong transaction IndexedDB.

### 6.2 Độc Lập Khỏi RAM Callbacks:
- Các sự kiện `onProjectionDirty`, `BroadcastChannel`, hay UI State Hook **CHỈ LÀ TÍN HIỆU TỐI ƯU HÓA ĐỘ TRỄ (Latency Optimization)** để thông báo React component render lại ngay lập tức trong tab đang mở.
- **Nếu xảy ra Crash, Reload, F5, hoặc Event bị mất:**
  - Lần đọc tiếp theo (khi người dùng mở lại trang, click vào truyện, chuyển tab): Projection Engine truy vấn trực tiếp từ IndexedDB.
  - Vì mutation đã bị xóa/quarantine bền vững trong IndexedDB ở Step 4, Projection tính toán lại và trả về trạng thái chuẩn hóa của Authoritative Shadow ngay lập tức.
  - **Bảo toàn 100% Step 4:** Hoàn toàn không cần sửa đổi bất kỳ logic callback nào trong `mutation-queue.ts`.

---

## 7. Khóa Lỗ Hổng P0-05: Checkpoint OCC Guard & Epoch Governance Trong Delta Pull

### 7.1 Checkpoint Optimistic Concurrency Control (OCC) Guard
Để ngăn chặn hai tiến trình pull đồng quy (hoặc race condition giữa 2 tab/worker) ghi đè checkpoint:
1. Trước khi mở transaction ghi, Reconciler đọc `expectedRevision = sync_meta.lastSyncedServerRevision`.
2. Mở 1 transaction `readwrite` duy nhất trên `['sync_authoritative_replicas', 'sync_meta']`.
3. Đọc lại `currentRevision = sync_meta.lastSyncedServerRevision` bên trong transaction lock:
   - **OCC Assertion:**
     ```typescript
     if (currentRevision !== expectedRevision) {
       tx.abort();
       throw new ConcurrentPullDetectedError(
         `OCC Checkpoint Mismatch: expected "${expectedRevision}", found "${currentRevision}". Pull transaction aborted.`
       );
     }
     ```
4. Áp dụng toàn bộ deltas và ghi đè checkpoint mới vào `sync_meta`.
5. Transaction commit.

### 7.2 Quản Lý Epoch Chặt Chẽ Theo Từng Domain & Thao Tác:
- **`HISTORY DELETE`:**
  - Bắt buộc kiểm tra: `delta.payload?.epoch` phải là số nguyên dương hợp lệ.
  - Nếu thiếu: Ném lỗi `MalformedDeltaPayloadError` và fail-closed ngay lập tức.
  - Ghi nhận `epoch = Number(delta.payload.epoch)` vào tombstone record và `sync_meta`.
- **`HISTORY UPSERT`:**
  - Server delta của `UPSERT` **KHÔNG TẠO RA EPOCH MỚI**.
  - Delta chỉ mang `progressPercentage` chuẩn hóa. Trường `observedHistoryEpoch` từ client chỉ dùng cho kiểm tra lúc push, không được dùng làm epoch mới cho server replica.
  - Shadow giữ nguyên `epoch` hiện tại của story/global.
- **`PROGRESS`:**
  - Ghi nhận tiến trình đọc. Kiểm tra causal: delta progress có revision phải lớn hơn tombstone revision của story đó.

---

## 8. Các Tinh Chỉnh P1 Cho IndexedDB v4

1. **Xử lý Thứ Tự Decimal Strings trên Index `by_scope_revision`:**
   - Trong IndexedDB, chuỗi được sắp xếp theo thứ tự từ điển (`"100" < "20"`).
   - **Quy tắc bất biến:** CẤM sử dụng `IDBKeyRange.bound` trực tiếp trên decimal strings để lấy thứ tự revision.
   - Index `by_scope_revision` CHỈ được dùng để tra cứu đẳng thức chính xác `['ownerScope', exactRevisionString]` hoặc prefix scan theo `ownerScope`.
   - Mọi thao tác so sánh lớn hơn/nhỏ hơn giữa các revision đều phải ép kiểu qua `BigInt(...)` trong JavaScript.
2. **Hydration Policy Cho UI Presentation:**
   - Server delta chỉ chứa dữ liệu thuần đồng bộ (ID, progress, timestamp), không chứa metadata trình bày (tiêu đề truyện, ảnh bìa).
   - Khi Projection Engine sinh trạng thái cho UI:
     - Nếu có thông tin trong local metadata catalog (`stories_catalog` / local cache): tự động hydrate để trả về đối tượng `LocalReadingHistory` / `LocalReadingProgress` hoàn chỉnh.
     - Nếu chưa có: trả về canonical projection kèm cờ `needsHydration: true` để component hiển thị skeleton / placeholder an toàn.
3. **Quy Tắc Tránh Ghi Đè Đồng Quy Vào Local Materialized Stores (`progress`, `history`):**
   - Projection Engine CHỈ thực hiện ghi đè ngược (materialize write-back) vào `progress` hoặc `history` khi:
     (1) Không có bất kỳ pending mutation nào đang hoạt động cho thực thể đó, HOẶC
     (2) Mutation vừa nhận terminal receipt và đã được dọn sạch khỏi `pending_mutations`.
   - Ngăn chặn hoàn toàn việc ghi đè làm mất thao tác đọc người dùng vừa thực hiện.
4. **Xử Lý Schema Upgrade Đa Tab (`onversionchange` & `onblocked`):**
   - Trong `indexed-db-client.ts`: Đăng ký listener `db.onversionchange`:
     Tự động đóng kết nối database (`db.close()`) và phát thông báo qua BroadcastChannel yêu cầu các tab đồng bộ reload.
   - Bắt sự kiện `request.onblocked` khi upgrade v3 $\to$ v4 để hiển thị thông báo thân thiện yêu cầu người dùng đóng các tab OmniNovel cũ.

---

## 9. Ma Trận Kiểm Thử Mở Rộng: ST-01 Đến ST-15

Toàn bộ 15 kịch bản kiểm thử bắt buộc phải thực thi trên IndexedDB thực tế (fake-indexeddb trong Vitest có deterministic barriers) và đối soát persisted state sau khi đóng/mở lại connection:

| Test ID | Mục tiêu kiểm thử | Kịch bản mô phỏng | Kết quả kỳ vọng |
| :--- | :--- | :--- | :--- |
| **ST-01** | Checkpoint & Shadow Atomicity | Ghi shadow gặp lỗi `QuotaExceededError` nhân tạo. | Cả shadow lẫn checkpoint trong `sync_meta` đều giữ nguyên, rollback 100%. |
| **ST-02** | Authoritative Payload Preservation | Shadow nhận Chương 3. User có pending Chương 5. Server reject Chương 5. | Projection hoàn nguyên về Chương 3 mà không cần network request. |
| **ST-03** | Step 4 Isolation Guard | Step 4 thực hiện `recordReadingSessionWithMutation()`. | `sync_authoritative_replicas` không bị ghi đè, `pending_mutations` nhận mutation bình thường. |
| **ST-04** | Monotonic History Upsert Merge | Shadow có 80%. Pending mutation gửi 30%. | Projection giữ nguyên 80%. Sau khi pending flush, shadow vẫn là 80%. |
| **ST-05** | Tombstone Eviction via Delta Pull | Delta Pull nhận `DELETE` với epoch mới. | Shadow chuyển `isDeleted = true`, projection lập tức xóa bản ghi khỏi UI. |
| **ST-06** | Multi-Scope Tenant Isolation | Scope `account:user-1` và Scope `guest:dev-1` cùng đọc 1 truyện. | Hai shadow records và hai projection hoàn toàn tách biệt theo composite key. |
| **ST-07** | Database v3 $\to$ v4 Migration | Nâng cấp từ database v3 có sẵn dữ liệu bookmarks, progress, history. | Toàn bộ dữ liệu cũ nguyên vẹn, store mới được khởi tạo với đúng indexes. |
| **ST-08** | **Story-wide HISTORY DELETE Cascading** | Shadow có 3 chapters của Story A. Nhận delta DELETE Story A. | Toàn bộ 3 chapter shadows của Story A bị xóa sạch; tombstone Story A được ghi nhận. |
| **ST-09** | **Global HISTORY DELETE Multi-Scope** | Scope A và Scope B đều có history. Nhận global DELETE tại Scope A. | Toàn bộ history/progress của Scope A bị xóa sạch; Scope B **giữ nguyên 100%**. |
| **ST-10** | **Baseline Bootstrap Guard** | v3 có checkpoint `"150"`, nâng cấp lên v4 với Shadow rỗng. | `authoritativeBaselineStatus` là `UNINITIALIZED`, từ chối `READY`, kích hoạt snapshot bootstrap. |
| **ST-11** | **Concurrent Pull OCC Abort** | Hai tiến trình pull cùng chạy trên checkpoint `"100"`. | Tiến trình 1 commit thành công `"105"`; Tiến trình 2 bị OCC abort với `ConcurrentPullDetectedError`. |
| **ST-12** | **Entity Key Mismatch Mapping** | Mutation HISTORY mang entityId khác format shadow `${storyId}:${chapterId}`. | Helper ánh xạ chuẩn xác, projection tìm thấy pending mutation tương ứng. |
| **ST-13** | **Post-Receipt Reload Determinism** | Mutation được `REJECTED_TOMBSTONE` trong IDB; kill tab ngay lập tức (không có RAM event). | Mở lại tab mới, projection đọc từ IDB và trả về trạng thái Shadow chuẩn xác 100%. |
| **ST-14** | **In-Page Tombstone Then Upsert** | Một trang delta chứa DELETE Story A, sau đó có UPSERT Story A với epoch mới. | Xử lý tuần tự theo revision: xóa cũ, sau đó chấp thuận bản ghi mới với epoch mới. |
| **ST-15** | **Concurrent Local Write vs Materialization** | Người dùng vừa đọc truyện (ghi local) đúng lúc projection materialization chạy. | Không bị ghi đè mất pending mutation của người dùng; pending intent được bảo toàn. |

---

## 10. Lộ Trình Triển Khai Sau Phê Duyệt Contract Gate (Phase 5.2 Phased Rollout)

Sau khi RFC Revision 2.1 được phê duyệt, Phase 5.2 sẽ được triển khai theo 4 bước phân rã nghiêm ngặt, đảm bảo không gây xáo trộn hệ thống:

```
[Contract Gate Approved] 
       │
       ▼
┌─────────────────────────────────────────────────────────────┐
│ Bước 5.2a: IndexedDB v4 Migration & Baseline Lifecycle      │
│ • Thêm store sync_authoritative_replicas                    │
│ • Cập nhật sync_meta với authoritativeBaselineStatus        │
│ • Kiểm thử ST-07, ST-10 (Vitest)                            │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Bước 5.2b: Authoritative Shadow DAL & OCC Delta Ingestion   │
│ • Atomic write transaction: Shadow + Checkpoint + OCC Guard │
│ • Cascading Eviction cho Story-wide & Global DELETE         │
│ • Kiểm thử ST-01, ST-05, ST-08, ST-09, ST-11, ST-14        │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Bước 5.2c: Causal Projection Engine & Hydration             │
│ • Pure deterministic function: Resolve(Shadow, Pending)     │
│ • Dual-layer tombstone suppression                          │
│ • Kiểm thử ST-02, ST-03, ST-04, ST-06, ST-12, ST-13, ST-15 │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Bước 5.2d: Delta Pull Reconciler Integration                │
│ • Kéo /sync/changes, phân trang checkpoint                  │
│ • Tích hợp Web Locks Tab Leader (Step 3)                    │
│ • Chạy toàn bộ 15/15 acceptance tests ST-01 đến ST-15       │
└─────────────────────────────────────────────────────────────┘
```

**Khuyến nghị:** Phê duyệt toàn văn tài liệu **Storage Coexistence RFC Revision 2.1** để chính thức đóng Contract Gate và mở khóa cấp phép cho **Bước 5.2a**.
