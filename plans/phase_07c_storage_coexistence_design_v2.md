# 🏛️ Kiến Trúc Coexistence Revision 2: Durable Authoritative Shadow & Optimistic Projection
## Đề Xuất Cải Tiến Cho Tầng Lưu Trữ Client-Side Web Sync (`apps/web` — Phase 5.2)

> **Tài liệu:** Thiết kế Kiến trúc Đồng Bộ Lưu Trữ Cục Bộ (Storage Coexistence RFC — Revision 2)  
> **Trạng thái:** `Chờ Nghiệm Thu (READY FOR GATE REVIEW)`  
> **Cơ sở pháp lý:** Thay thế hoàn toàn phương án Overlay Metadata Flag (`_syncStatus: 'COMMITTED' | 'DIRTY_PENDING'`) đã bị BLOCKED tại Gate Review Phase 5.1.  
> **Mục tiêu:** Bảo toàn 100% Authoritative Server Payload khi có pending local optimistic mutations; giữ nguyên vẹn 100% Step 4 Frozen Baseline (`mutation-queue.ts`).

---

## 1. Phân Tích Lỗi Thiết Kế P0 Của Phương Án Cũ (Revision 1 Overlay)

### 1.1 Kịch bản dẫn đến mất mát dữ liệu Authoritative Payload:
1. **Trạng thái ban đầu:** Client và Server đồng bộ ở Chương 3.
2. **Local Optimistic Mutation:** Người dùng đọc tiếp đến Chương 5 khi offline hoặc trước khi network kịp gửi. Local store `progress` ghi nhận Chương 5 và đưa mutation Chương 5 vào `pending_mutations`.
3. **Delta Pull kích hoạt:** Web Client kéo changes từ Server, nhận delta Chương 3 (hoặc do thiết bị khác cập nhật).
4. **Hành vi sai lầm của Revision 1:**
   - Để tránh làm gián đoạn UI đang đọc Chương 5, Delta Pull **chỉ cập nhật metadata** `_lastCommittedServerRevision`, nhưng giữ nguyên payload `chapterId` là Chương 5.
   - Checkpoint `lastSyncedServerRevision` được nâng lên sau khi trang delta commit.
5. **Thất bại không thể phục hồi (The P0 Defect):**
   - Server từ chối mutation Chương 5 (do xung đột epoch, tombstone, hoặc permission).
   - Mutation Chương 5 bị loại bỏ khỏi hàng đợi (`quarantined_mutations` hoặc evicted).
   - Lúc này: Local record vẫn trỏ ở Chương 5. Checkpoint đã vượt qua delta Chương 3.
   - **Hậu quả:** Client **hoàn toàn mất trắng payload Chương 3 của Server**. Client không thể tự khôi phục về Chương 3 mà bắt buộc phải kéo lại từ đầu hoặc rơi vào kịch bản Full Snapshot Resync tốn kém. Metadata revision không thể thay thế cho dữ liệu thật (payload).
6. **Xâm phạm Step 4 Frozen Baseline:**
   - Revision 1 đòi hỏi sửa đổi giao dịch atomic của Mutation Queue để cập nhật cờ `_syncStatus = 'COMMITTED'` và xóa pending mutation cùng lúc. Đây là hành vi can thiệp trái phép vào Step 4 đã được ký đóng băng (FROZEN CLEAN).

---

## 2. Kiến Trúc 4 Tầng: Durable Authoritative Shadow & Optimistic Projection

Thay vì cố gắng lưu hai loại sự thật (Server Truth và Local Optimistic Intent) vào trong một bản ghi duy nhất, Revision 2 tách biệt hoàn toàn thành 4 thành phần trực giao:

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   UI / Reader Components                                │
└───────────────────────────────────────────▲─────────────────────────────────────────────┘
                                            │ Reads Projected State
┌───────────────────────────────────────────┴─────────────────────────────────────────────┐
│                 TẦNG 3: UI PROJECTION ENGINE (Materialized / Derived)                   │
│   Projection = CausalResolve(Authoritative Shadow, In-Memory / Pending Mutations)       │
└───────────────────▲─────────────────────────────────────────────────▲───────────────────┘
                    │ Reads Canonical Truth                           │ Reads Optimistic
┌───────────────────┴─────────────────────────┐   ┌───────────────────┴───────────────────┐
│     TẦNG 1: AUTHORITATIVE SHADOW            │   │        TẦNG 2: PENDING QUEUE          │
│ Store: sync_authoritative_replicas          │   │ Store: pending_mutations              │
│ Key: [ownerScope, domain, entityKey]        │   │ Key: [ownerScope, mutationId]         │
│ • Raw server payload, revision, epoch       │   │ • Step 4 Quản lý (FROZEN CLEAN)       │
│ • CHỈ GHI BỞI: Delta Pull / Snapshot Triage │   │ • CHỈ GHI BỞI: Local User Actions     │
│ • Local mutations TUYỆT ĐỐI KHÔNG GHI ĐÈ    │   │ • Bị xóa khi APPLIED/REJECTED_TOMB    │
└───────────────────▲─────────────────────────┘   └───────────────────▲───────────────────┘
                    │ Ingest Deltas                                   │ Atomic Enqueue
┌───────────────────┴─────────────────────────┐   ┌───────────────────┴───────────────────┐
│      Step 5: Delta Pull Reconciler          │   │      Step 4: Local Mutation Writer    │
│      Step 6: Snapshot Triage Engine         │   │  recordReadingSessionWithMutation()   │
└─────────────────────────────────────────────┘   └───────────────────────────────────────┘
```

### Bảng Trách Nhiệm Từng Thành Phần:

| Thành phần | Object Store | Chủ thể ghi (Write Authority) | Vòng đời & Trách nhiệm |
| :--- | :--- | :--- | :--- |
| **Authoritative Shadow** | `sync_authoritative_replicas` | **CHỈ Delta Pull & Snapshot Triage** | Lưu trữ nguyên bản 100% payload nhận từ Server kèm `serverRevision` và `epoch`. Miễn nhiễm hoàn toàn trước các thao tác ghi lạc quan của người dùng. |
| **Pending Queue** | `pending_mutations` | **Step 4 Mutation Queue** *(Đóng băng)* | Lưu trữ các mutation chưa được Server chấp thuận kèm ID, thao tác, payload và causal metadata. Giữ nguyên 100% implementation Step 4. |
| **Local Materialized Stores** | `progress`, `bookmarks`, `history`, `preferences` | **Projection Engine / Step 4 Cache** | Đóng vai trò là cache hiển thị tức thì (UI cache) và offline fallback cho reader. Tương thích ngược schema v3. |
| **UI Projection Engine** | Pure in-memory computation + sync-to-cache | **Reader Hooks / Data Access Layer** | Tính toán trạng thái hiển thị bằng cách áp dụng các quy tắc nhân quả (Causal Rules) giữa Shadow và Pending Queue. Khi Server từ chối mutation, projection tự động trở về Shadow nguyên bản mà không mất dữ liệu. |

---

## 3. Thiết Kế Chi Tiết Schema IndexedDB v4

Hệ thống nâng cấp database `omninovel_local_v2` từ `DB_VERSION = 3` lên `DB_VERSION = 4` qua sự kiện `onupgradeneeded`.

### 3.1 Object Store Mới: `sync_authoritative_replicas`

```typescript
export interface AuthoritativeShadowRecord {
  /** Phân vùng account/guest isolation: 'account:<id>' | 'guest:<id>' */
  ownerScope: string;
  /** Domain đồng bộ: 'BOOKMARK' | 'PROGRESS' | 'HISTORY' | 'PREFERENCE' */
  domain: SyncDomain;
  /** Khóa định danh thực thể chuẩn hóa theo từng miền */
  entityKey: string;
  /** PostgreSQL 64-bit BIGINT lưu dưới dạng Decimal String */
  serverRevision: string;
  /** Epoch lịch sử hữu hiệu tại thời điểm server phát hành */
  epoch: number;
  /** Raw server payload nguyên bản từ Cloud (null nếu bị xóa / tombstone) */
  payload: Record<string, any> | null;
  /** Đánh dấu xóa từ server delta DELETE */
  isDeleted: boolean;
  /** Timestamp ghi nhận bản ghi shadow tại client (epoch ms) */
  updatedAt: number;
}
```

* **KeyPath:** `['ownerScope', 'domain', 'entityKey']` (Composite Primary Key).
* **Indexes:**
  1. `by_scope_domain`: `['ownerScope', 'domain']` — Phục vụ truy vấn projection theo từng domain.
  2. `by_scope_revision`: `['ownerScope', 'serverRevision']` — Phục vụ kiểm tra GC / compaction và triage.

### 3.2 Quy Chuẩn Định Danh Khóa Chuẩn Hóa (`entityKey`) Theo Miền:

| Miền (`domain`) | Cấu trúc `entityKey` | Ví dụ | Ý nghĩa |
| :--- | :--- | :--- | :--- |
| `PROGRESS` | `storyId` | `11111111-2222-3333-4444-555555555555` | Tiến trình đọc gần nhất gắn theo từng bộ truyện. |
| `HISTORY` | `${storyId}:${chapterId}` hoặc UUID Sentinel | `...:...` hoặc `00000000-0000-0000-0000-000000000000` | Lịch sử đọc từng chương hoặc tombstone xóa toàn bộ. |
| `BOOKMARK` | `storyId` | `11111111-2222-3333-4444-555555555555` | Đánh dấu truyện theo từng bộ truyện. |
| `PREFERENCE` | `key` | `reader_theme`, `font_family` | Cài đặt người dùng theo từng cấu hình. |

---

## 4. Tính Nguyên Tử Checkpoint & Bất Biến Ghi Delta Pull (Step 5.2)

### Bất biến S1: Giao dịch đơn nguyên tử (Single Atomic Transaction)
Khi Delta Pull nhận một trang thay đổi (`SyncChangesResponseDto`):
1. Mở **1 transaction `readwrite` duy nhất** bao gồm 2 stores: `['sync_authoritative_replicas', 'sync_meta']`.
2. Áp dụng toàn bộ deltas trong trang vào `sync_authoritative_replicas`:
   - Nếu `operation === 'UPSERT'`: ghi đè shadow record với `payload` từ server, `serverRevision = delta.revision`, `epoch = delta.payload.epoch ?? 0`, `isDeleted = false`.
   - Nếu `operation === 'DELETE'`: ghi shadow record với `payload = null`, `isDeleted = true`, `serverRevision = delta.revision`, `epoch = delta.payload.epoch ?? 0`.
3. Cập nhật checkpoint trong `sync_meta`:
   - Nếu `hasMore === true`: `lastSyncedServerRevision = response.nextRevision`.
   - Nếu `hasMore === false`: `lastSyncedServerRevision = response.currentServerRevision`.
4. Transaction commit.
5. **Đảm bảo thất bại:** Nếu quota trình duyệt bị đầy hoặc transaction abort, cả shadow lẫn checkpoint đều **không thay đổi**. Không bao giờ xảy ra tình trạng checkpoint đi trước shadow.

### Bất biến S2: Tuyệt đối không can thiệp Step 4 Mutation Queue
- Delta Pull **KHÔNG** mở transaction trên `pending_mutations`.
- Delta Pull **KHÔNG** sửa cờ `_syncStatus` hay payload của pending mutations.
- Delta Pull **KHÔNG** xóa bất kỳ pending mutation nào (quyền sở hữu xóa pending mutation thuộc về Step 4 Receipt Handler khi nhận kết quả HTTP batch push).

---

## 5. Quy Tắc Phân Giải Causal Projection (Projection Engine)

Khi Reader UI hoặc Client Store cần lấy trạng thái hiển thị của một thực thể:
$$\text{ProjectedState} = \text{Resolve}(\text{AuthoritativeShadow}, \text{PendingMutations})$$

### 5.1 Thuật toán phân giải chi tiết:

1. **Khởi tạo trạng thái nền (Base State):**
   - Đọc bản ghi từ `sync_authoritative_replicas` theo `(ownerScope, domain, entityKey)`.
   - Nếu không tồn tại hoặc `isDeleted === true`, `baseState = null`.
   - Ngược lại, `baseState = shadow.payload`.

2. **Lấy danh sách Pending Mutations:**
   - Lọc các mutation trong `pending_mutations` có cùng `ownerScope`, `domain`, và `entityId` khớp với `entityKey`.
   - Sắp xếp theo thứ tự thời gian tạo (`createdAt` tăng dần).

3. **Áp dụng Causal Rules:**
   - **Nếu không có Pending Mutation nào:**
     $$\text{ProjectedState} \equiv \text{baseState}$$
     *(Trạng thái tĩnh chuẩn xác 100% từ Server)*.
   - **Nếu có Pending Mutation:**
     Lần lượt duyệt qua các pending mutations:
     - **Thao tác `DELETE`:**
       Trạng thái chiếu chuyển thành `null` (đã xóa cục bộ).
     - **Thao tác `UPSERT` theo từng miền:**
       - **Miền `PROGRESS`:**
         - Kiểm tra epoch nhân quả: Nếu `mutation.payload.observedHistoryEpoch < shadow.epoch`, mutation là stale/vi phạm tombstone -> Bỏ qua, giữ nguyên `baseState`.
         - Nếu `observedHistoryEpoch >= shadow.epoch`:
           - Nếu `baseState == null`: `ProjectedState = mutation.payload`.
           - Nếu `baseState != null`: Áp dụng quy tắc monotonic reading (nếu chương đọc hoặc vị trí cuộn của pending mutation lớn hơn hoặc bằng shadow, pending mutation thắng; ngược lại shadow thắng).
       - **Miền `HISTORY`:**
         - `progressPercentage = Math.max(shadow?.progressPercentage ?? 0, mutation.payload.progressPercentage)`.
       - **Miền `BOOKMARK` & `PREFERENCE`:**
         - Áp dụng Last-Write-Wins (LWW) cục bộ: pending mutation ghi đè lên shadow.

---

## 6. Vòng Đời Phục Hồi Khi Server Reject Hoặc Reload Tab

### 6.1 Khắc phục triệt để lỗi P0 (Server Rejection Recovery):
Xét lại kịch bản lỗi P0:
1. `AuthoritativeShadow`: Chương 3 (Server revision `100`).
2. `PendingQueue`: Mutation $M_5$ (Chương 5, offline).
3. `UI Projection`: Hiển thị Chương 5 (do $M_5$ có vị trí cao hơn Chương 3).
4. Delta Pull chạy xong một batch khác, checkpoint nâng lên revision `105`.
5. Server từ chối mutation $M_5$ (trả về `REJECTED_TOMBSTONE` hoặc `REJECTED_STALE`).
6. **Cơ chế phục hồi của Revision 2:**
   - Step 4 Receipt Handler chuyển $M_5$ sang `quarantined_mutations` hoặc xóa khỏi `pending_mutations`.
   - Event `onProjectionDirty` được kích hoạt.
   - Projection Engine chạy lại:
     - `AuthoritativeShadow`: Vẫn giữ nguyên vẹn 100% dữ liệu Chương 3!
     - `PendingQueue`: Trống.
     - `UI Projection`: **Tự động trở về Chương 3 ngay lập tức**.
   - CSDL UI `progress` được cập nhật đồng bộ về Chương 3.
   - **Kết quả:** Không mất dữ liệu, không cần re-pull, không lỗi checkpoint!

### 6.2 Vòng đời khi Reload hoặc Khởi động lại ứng dụng:
- Khi người dùng F5 hoặc mở tab mới:
  - `sync_authoritative_replicas` đã được lưu bền vững trên đĩa.
  - `pending_mutations` đã được lưu bền vững trên đĩa (Step 4).
  - Reader mở lên lập tức đọc projection kết hợp giữa Shadow và Pending. Trải nghiệm người dùng liền mạch 100% dù có đang offline.

---

## 7. Kế Hoạch Chuyển Đổi (Migration Plan) Từ v3 Lên v4

### 7.1 Thao Tác Migration Không Mất Dữ Liệu (`indexed-db-client.ts`):
```typescript
if (oldVersion < 4) {
  if (!db.objectStoreNames.contains('sync_authoritative_replicas')) {
    const replicaStore = db.createObjectStore('sync_authoritative_replicas', {
      keyPath: ['ownerScope', 'domain', 'entityKey'],
    });
    replicaStore.createIndex('by_scope_domain', ['ownerScope', 'domain'], { unique: false });
    replicaStore.createIndex('by_scope_revision', ['ownerScope', 'serverRevision'], { unique: false });
  }
}
```

### 7.2 Tính Tương Thích Ngược:
- Các stores hiện hữu: `bookmarks`, `progress`, `history`, `preferences` được giữ nguyên vẹn 100%.
- Dữ liệu lịch sử đọc v3 của người dùng không bị xóa.
- Khi khởi chạy Delta Pull lần đầu trên v4, các server deltas mới sẽ tự động điền vào `sync_authoritative_replicas`.

---

## 8. Ma Trận Kiểm Thử Tự Động Cho Revision 2 (Verification Matrix)

| Test Case ID | Mục Tiêu Kiểm Thử | Kịch Bản Mô Phỏng | Kết Quả Kỳ Vọng |
| :--- | :--- | :--- | :--- |
| **ST-01** | Checkpoint & Shadow Atomicity | Transaction ghi shadow gặp lỗi `QuotaExceededError` nhân tạo. | Cả shadow record lẫn checkpoint trong `sync_meta` đều giữ nguyên, rollback 100%. |
| **ST-02** | Authoritative Payload Preservation | Shadow nhận Chương 3. User có pending Chương 5. Server reject Chương 5. | Projection ngay lập tức hoàn nguyên về Chương 3 mà không cần network request. |
| **ST-03** | Step 4 Isolation Guard | Step 4 thực hiện `recordReadingSessionWithMutation()`. | `sync_authoritative_replicas` không bị ghi đè, `pending_mutations` nhận mutation bình thường. |
| **ST-04** | Monotonic History Upsert Merge | Shadow có 80%. Pending mutation gửi 30%. | Projection giữ nguyên 80%. Sau khi pending flush, shadow vẫn là 80%. |
| **ST-05** | Tombstone Eviction via Delta Pull | Delta Pull nhận `DELETE` với epoch mới. | Shadow chuyển `isDeleted = true`, projection lập tức xóa bản ghi khỏi UI. |
| **ST-06** | Multi-Scope Tenant Isolation | Scope `account:user-1` và Scope `guest:dev-1` cùng đọc 1 truyện. | Hai shadow records và hai projection hoàn toàn tách biệt theo composite key. |
| **ST-07** | Database v3 to v4 Migration | Nâng cấp từ database v3 có sẵn dữ liệu bookmarks, progress, history. | Toàn bộ dữ liệu cũ nguyên vẹn, store mới được khởi tạo với đúng indexes. |

---

## 9. Kết Luận & Đề Xuất Phê Duyệt

Kiến trúc **Revision 2: Durable Authoritative Shadow & Optimistic Projection** khắc phục triệt để lỗ hổng P0 của Revision 1 bằng cách phân định rành mạch hai dòng dữ liệu:
1. **Authoritative Truth:** Lưu bền vững trong `sync_authoritative_replicas`, miễn nhiễm trước optimistic writes.
2. **Optimistic Intent:** Quản lý bởi Step 4 Mutation Queue đã đóng băng.

**Khuyến nghị:** Phê duyệt tài liệu thiết kế Revision 2 làm cơ sở kỹ thuật chính thức để dỡ bỏ trạng thái BLOCKED và tiến hành cấp phép triển khai **Phase 5.2 (Web Delta Pull Reconciler)**.
