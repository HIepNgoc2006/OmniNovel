# 🏛️ Kiến Trúc Coexistence Revision 2.2: Tombstone-Safe Shadow, Epoch Governance & Baseline Lifecycle
## Đề Xuất Hoàn Thiện Tầng Lưu Trữ Client-Side Web Sync (`apps/web` — Phase 5.2)

> **Tài liệu:** Thiết kế Kiến trúc Đồng Bộ Lưu Trữ Cục Bộ (Storage Coexistence RFC — Revision 2.2)  
> **Trạng thái:** `Đã Hoàn Thiện Hợp Đồng & Phê Duyệt Bước 5.2a (APPROVED FOR 5.2a IMPLEMENTATION)`  
> **Cơ sở pháp lý:** Phán quyết Conditional Approval từ Gate Review Storage Coexistence Revision 2.1 (Commit `f6a7349`).  
> **Mục tiêu:** Khóa toàn diện các bất biến kỹ thuật: Baseline Lifecycle (mặc định `UNINITIALIZED`), Epoch Governance (`effectiveHistoryEpochs: Record<string, number>`), Post-Receipt Reconciliation & In-Flight Grace, Snapshot Baseline Metadata, và Triển khai Bước 5.2a (IndexedDB v4 Migration).

---

## 1. Tổng Quan & Cập Nhật Hợp Đồng Tại Revision 2.2

Dựa trên kết quả rà soát kiến trúc tại Gate Review, Revision 2.2 hoàn thiện 5 điểm cốt lõi:

| Vấn đề | Điểm bất nhất ở Revision 2.1 | Hợp đồng chuẩn hóa tại Revision 2.2 |
| :--- | :--- | :--- |
| **P0-01: Baseline Checkpoint "0"** | Revision 2.1 cho rằng `lastSyncedServerRevision === '0'` thì Shadow đã `READY`. | **Mặc định `UNINITIALIZED`:** Revision "0" chỉ chứng minh client chưa sync trên máy này, không chứng minh server không có dữ liệu (kịch bản đăng nhập thiết bị mới). Mọi account scope chưa được xác minh baseline đều bắt đầu từ `UNINITIALIZED`. Chỉ chuyển sang `READY` sau khi hoàn tất Snapshot Bootstrap hoặc Replay đầy đủ. |
| **P0-02: Snapshot Metadata & Global Epoch** | Revision 2.1 giả định snapshot response có `snapshot.effectiveHistoryEpoch`. Thực tế response API chỉ có `chapterReadStates[].storyHistoryEpoch`. | **Epoch Contract & Tombstone Ingestion:** Đối với account đã xóa toàn bộ lịch sử (chapter list rỗng), client không suy đoán global epoch từ danh sách rỗng. Hợp đồng quy định server phát snapshot metadata chứa `effectiveHistoryEpochs` hoặc client tra cứu tombstone sentinel trong snapshot staging trước khi đóng dấu `READY`. |
| **P0-03: Epoch Model trong `sync_meta`** | Revision 2.1 dùng trường số đơn `sync_meta.effectiveHistoryEpoch`. | **Bảo toàn `effectiveHistoryEpochs: Record<string, number>`:** Giữ nguyên mô hình map trong `LocalSyncMeta`. Khóa `00000000-0000-0000-0000-000000000000` lưu global epoch; các khóa khác lưu story epoch. Effective epoch = $\max(\text{storyEpoch}, \text{globalEpoch})$. Gán epoch chuẩn cho UPSERT sau tombstone để không bị xóa nhầm. |
| **P0-04: Shadow Freshness sau Terminal Receipt** | Revision 2.1 giả định xóa pending mutation là Shadow lập tức có dữ liệu server mới nhất. | **Bounded In-Flight Grace & Reconciliation Obligation:** Khi nhận `APPLIED`, pending mutation được dọn nhưng Shadow chưa có revision mới. Projection duy trì trạng thái optimistic trong cửa sổ ngắn (bounded grace state) hoặc kích hoạt ngay `RECONCILIATION_REQUIRED` để kéo delta, tránh giật lùi UI (flicker). |
| **P0-05: Anti-Tombstone Guard cho Pending Mutations** | Revision 2.1 chỉ kiểm tra epoch của pending mutation khi có `observedHistoryEpoch`. | **Causal Revision & Tombstone Guard:** Kiểm tra cả `mutation.baseServerRevision` so với `tombstone.deletedAtRevision`. Nếu mutation gửi lên dựa trên revision cũ hơn tombstone, pending mutation bị coi là stale và bị che khuất trong projection. |

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
│   • Dual-Layer Tombstone & Causal Revision Suppression Guard                            │
│   • Bounded Reconciliation Grace State khi Shadow chưa kịp kéo revision mới             │
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

## 3. Khóa Lỗ Hổng P0-01: Baseline Lifecycle & Mặc Định `UNINITIALIZED`

### 3.1 Vòng Đời Trạng Thái Baseline (`authoritativeBaselineStatus`)

```typescript
export type AuthoritativeBaselineStatus = 
  | 'UNINITIALIZED' // Shadow rỗng hoặc chưa được kiểm chứng, bắt buộc bootstrap
  | 'BOOTSTRAPPING'  // Đang trong tiến trình kéo snapshot nạp shadow
  | 'READY';         // Shadow đã hoàn chỉnh, projection kích hoạt đầy đủ
```

### 3.2 Bất Biến Khởi Tạo (Admission Rules):
1. **Thiết Bị Mới / Checkpoint "0":**
   - Khi `sync_meta` chưa tồn tại hoặc `lastSyncedServerRevision === '0'`: trạng thái khởi tạo **BẮT BUỘC là `'UNINITIALIZED'`**.
   - **Lý do:** Client chưa có dữ liệu không đồng nghĩa với Server chưa có dữ liệu. Người dùng đăng nhập thiết bị mới phải bootstrap trước khi Shadow được coi là `READY`.
2. **Upgrade Từ v3 Lên v4 (Migration):**
   - Mọi bản ghi `sync_meta` hiện hữu khi nâng cấp lên v4 đều được gán `authoritativeBaselineStatus = 'UNINITIALIZED'`.
3. **Phục Hồi Sau Crash Giữa Chừng (`Interrupted Bootstrap`):**
   - Nếu client bị tắt nguồn hoặc crash khi đang ở `BOOTSTRAPPING`: lần khởi động tiếp theo phát hiện trạng thái chưa `READY` $\implies$ tự động reset về `UNINITIALIZED` để khởi động lại bootstrap an toàn.
4. **Degraded Compatibility Mode Trong Thời Gian Chưa `READY`:**
   - Khi `authoritativeBaselineStatus !== 'READY'`:
     - UI Projection hoạt động ở chế độ tương thích an toàn: đọc trực tiếp từ legacy stores (`bookmarks`, `progress`, `history`, `preferences`).
     - Step 4 tiếp tục nhận mutations bình thường.
     - Tuyệt đối cấm kích hoạt Shadow làm nguồn chân lý duy nhất cho UI khi chưa `READY`.

---

## 4. Khóa Lỗ Hổng P0-02 & P0-03: Epoch Governance & Snapshot Baseline Metadata

### 4.1 Bảo Toàn Cấu Trúc `effectiveHistoryEpochs: Record<string, number>` Trong `LocalSyncMeta`

Bảo toàn 100% cấu trúc hiện hữu của `LocalSyncMeta`:
```typescript
export interface LocalSyncMeta {
  ownerScope: string;
  lastSyncedServerRevision: string;
  minActiveRevision: string;
  lastSyncTimestamp: string;
  effectiveHistoryEpochs: Record<string, number>; // Map storyId -> epoch & sentinel -> epoch
  syncState: 'IDLE' | 'PULLING' | 'PUSHING' | 'RECONCILING_410' | 'ERROR';
  lastErrorMessage?: string | null;
  authoritativeBaselineStatus?: AuthoritativeBaselineStatus; // Phase 5.2a
}
```

* **Khóa Global Sentinel:** Khóa `'00000000-0000-0000-0000-000000000000'` lưu epoch của lần xóa toàn bộ gần nhất.
* **Khóa Story-Specific:** Mỗi `storyId` có một epoch riêng khi có `HISTORY DELETE` theo truyện.
* **Effective Epoch của một truyện:**
  $$\text{effectiveEpoch}(storyId) = \max\Big(\text{effectiveHistoryEpochs}[storyId] \;\text{??}\; 0,\; \text{effectiveHistoryEpochs}[\text{UUID\_SENTINEL}] \;\text{??}\; 0\Big)$$

### 4.2 Gán Epoch Chuẩn Cho UPSERT Sau Tombstone
Khi Server phát delta `HISTORY UPSERT` tại revision 101 (sau một DELETE tại revision 100 với epoch 4):
- Bản ghi `chapter_read_states` trên server mang `epoch = 4`.
- Shadow lưu trữ `epoch = 4`.
- Bộ lọc suppression: Bản ghi chỉ bị che khuất nếu `record.epoch < effectiveEpoch`. Vì `4 < 4` là False, bản ghi mới tại revision 101 **được hiển thị bình thường, không bị xóa nhầm**.

### 4.3 Snapshot Baseline Epoch Metadata (Chuẩn Bị Cho Step 6)
Khi thực hiện Snapshot Bootstrap:
- Client xử lý `chapterReadStates[]` từ snapshot, cập nhật `effectiveHistoryEpochs[storyId] = item.storyHistoryEpoch`.
- Nếu danh sách `chapterReadStates` rỗng (account đã xóa sạch lịch sử): Client đọc các tombstones từ snapshot staging store hoặc server metadata endpoint để điền đúng `effectiveHistoryEpochs[UUID_SENTINEL]`. Không suy đoán epoch nếu thiếu bằng chứng.

---

## 5. Khóa Lỗ Hổng P0-04: Post-Receipt Reconciliation & Bounded Grace State

### 5.1 Vấn Đề Lệch Pha (Phase Mismatch) Sau Terminal Receipt
1. Client có mutation $M_5$ (Chương 5, offline). Shadow đang ở Chương 3 (rev 100).
2. Server chấp nhận $M_5$, gán revision 105, trả về `APPLIED`.
3. Step 4 xóa $M_5$ khỏi `pending_mutations`.
4. Nếu Projection lập tức chỉ đọc Shadow (đang ở rev 100): UI sẽ bị giật lùi về Chương 3 cho đến khi Delta Pull kéo được rev 105!

### 5.2 Cơ Chế Bounded In-Flight Grace & Reconciliation Trigger
- Khi Step 4 commit receipt `APPLIED` với `assignedRevision > lastSyncedServerRevision`:
  - Web Sync Reconciler ghi nhận cờ `reconciliationPending = true` và lập tức kích hoạt Delta Pull ưu tiên cao.
  - Projection Engine áp dụng **Bounded Reconciliation Grace State**: tạm thời duy trì hình ảnh của mutation vừa được commit trong bộ nhớ cache projection cho đến khi Delta Pull kéo thành công revision $\ge \text{assignedRevision}$ (hoặc hết timeout 5 giây).
  - Khi Delta Pull hoàn tất: Shadow được cập nhật lên Chương 5 (rev 105), cờ grace được giải phóng. UI chuyển đổi mượt mà 100%, không giật lùi.

---

## 6. Khóa Lỗ Hổng P0-05: Anti-Tombstone Guard Cho Pending Mutations

Khi phân giải `PROGRESS`:
1. Nếu pending mutation có `observedHistoryEpoch`:
   - So sánh: `mutation.observedHistoryEpoch < effectiveEpoch(storyId)` $\implies$ Mutation bị coi là stale/vi phạm tombstone, bị che khuất khỏi projection.
2. Nếu pending mutation **KHÔNG CÓ** `observedHistoryEpoch` (trường optional):
   - So sánh nhân quả: Nếu `BigInt(mutation.baseServerRevision) < BigInt(tombstone.serverRevision)` $\implies$ Mutation được tạo ra dựa trên trạng thái trước khi xóa, bị coi là stale và **bị loại bỏ khỏi projection**, ngăn chặn hoàn toàn việc làm sống lại bản ghi đã bị xóa.

---

## 7. Phạm Vi Triển Khai Phê Duyệt: Bước 5.2a (IndexedDB v4 Migration)

Bước 5.2a được triển khai độc lập, khép kín trong `apps/web`:

### 7.1 Thay Đổi Schema (`indexed-db-client.ts`)
* `DB_VERSION = 4`.
* Bổ sung `STORE_AUTHORITATIVE_REPLICAS = 'sync_authoritative_replicas'`:
  - `keyPath: ['ownerScope', 'domain', 'entityKey']`.
  - Index `by_scope_domain: ['ownerScope', 'domain']`.
  - Index `by_scope_revision: ['ownerScope', 'serverRevision']`.
* Bổ sung `authoritativeBaselineStatus` vào `LocalSyncMeta`.
* Nâng cấp `onupgradeneeded`:
  - Khởi tạo store thứ 9 trên database mới.
  - Nâng cấp từ v3 lên v4: giữ nguyên 100% dữ liệu của 8 stores cũ.
  - Thiết lập `authoritativeBaselineStatus = 'UNINITIALIZED'` cho mọi scope hiện hữu.
* Nâng cấp `purgeScope`: Xóa đồng bộ cả `STORE_AUTHORITATIVE_REPLICAS`.
* Đăng ký listeners `onversionchange` (đóng database connection an toàn) và `onblocked`.

### 7.2 Các Bất Biến Giới Hạn Của Bước 5.2a
1. **Không thực hiện Snapshot Bootstrap thật:** Chưa gọi API snapshot hay chuyển `READY`.
2. **Không bật Shadow làm nguồn dữ liệu UI:** Giữ nguyên legacy read models cho đến khi Step 5.2c hoàn tất.
3. **Không sửa Mutation Queue:** Step 4 giữ nguyên 100% mã nguồn đóng băng.
4. **Scope Isolation:** Guest scope không được kích hoạt authenticated sync.

---

## 8. Ma Trận Kiểm Thử Bước 5.2a (ST-07 & ST-10 Mở Rộng)

Tạo file kiểm thử chuyên biệt: `apps/web/src/test/indexed-db-v4-migration.spec.ts`:

| Mã Test | Tên Kịch Bản Kiểm Thử | Yêu Cầu Xác Minh |
| :--- | :--- | :--- |
| **ST-07A** | Fresh Database v4 Creation | Khởi tạo DB mới: tạo đủ 9 object stores, đúng composite keyPaths và indexes. |
| **ST-07B** | Migration v3 $\to$ v4 Data Preservation | Database v3 có sẵn dữ liệu 8 stores: nâng lên v4 bảo toàn 100% dữ liệu cũ, thêm store thứ 9 rỗng. |
| **ST-07C** | Multi-Tab Versionchange Handling | Đang mở kết nối v3, kết nối thứ hai mở v4: kết nối cũ nhận `onversionchange` và đóng an toàn. |
| **ST-10A** | Baseline Default UNINITIALIZED on Rev 0 | Account mới với checkpoint "0" hoặc thiếu `sync_meta`: `authoritativeBaselineStatus` là `UNINITIALIZED`. |
| **ST-10B** | Baseline UNINITIALIZED on Rev > 0 | Nâng cấp từ v3 có checkpoint "150": `authoritativeBaselineStatus` tự động là `UNINITIALIZED`. |
| **ST-10C** | Fail-Closed Admission Guard | `isAuthoritativeReady` trả về `false` khi `UNINITIALIZED` hoặc `BOOTSTRAPPING`; chỉ `true` khi `READY`. |
| **ST-10D** | Interrupted Bootstrap Recovery | Scope ở `BOOTSTRAPPING` sau crash/reload: Reconciler nhận diện chưa `READY` và cho phép reset an toàn. |
| **ST-10E** | Scope Isolation & Guest Guard | Thao tác baseline trên `account:user-1` không ảnh hưởng `guest:dev-1` hay `account:user-2`. |
| **ST-10F** | PurgeScope Wipes 9 Stores | `purgeScope` dọn sạch cả 9 stores cho target scope, không ảnh hưởng scope khác. |

---

## 9. Kết Luận

Tài liệu **Storage Coexistence Revision 2.2** đã chuẩn hóa toàn diện 5 vấn đề cốt lõi. Bước **5.2a (IndexedDB v4 Migration & Baseline Lifecycle)** đã được phê duyệt có phạm vi giới hạn để bắt đầu triển khai ngay lập tức.
