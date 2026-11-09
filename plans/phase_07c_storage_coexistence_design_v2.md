# 🏛️ Kiến Trúc Coexistence Revision 2.2: Tombstone-Safe Shadow, Epoch Governance & Baseline Lifecycle
## Đề Xuất Hoàn Thiện Tầng Lưu Trữ Client-Side Web Sync (`apps/web` — Phase 5.2)

> **Tài liệu:** Thiết kế Kiến trúc Đồng Bộ Lưu Trữ Cục Bộ (Storage Coexistence RFC — Revision 2.2)  
> **Trạng thái:** `Step 5.2a & Step 5.2b FROZEN CLEAN (Hosted CI #42053644100) — Step 5.2c + P1-01 Controlled Unlock IMPLEMENTED AT a695a1e / HOSTED CI #42608246872 (7/7 PASS, 865/865 Web Vitest, 15/15 IDB v5 Migration) — FINAL GATE VERIFICATION SUBMITTED ON docs/step-52c-final-gate-closure (READY LOCKED, KHÔNG TỰ ĐÓNG FROZEN CLEAN)`  
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

## 8. Ma Trận Kiểm Thử Bước 5.2a (ST-07 & ST-10 Mở Rộng & Negative Admission Regressions)

Tạo file kiểm thử chuyên biệt: `apps/web/src/test/indexed-db-v4-migration.spec.ts`:

| Mã Test | Tên Kịch Bản Kiểm Thử | Yêu Cầu Xác Minh | Kết Quả |
| :--- | :--- | :--- | :--- |
| **ST-07A** | Fresh Database v4 Creation | Khởi tạo DB mới: tạo đủ 9 object stores, đúng composite keyPaths và indexes. | **PASS** (11ms) |
| **ST-07B** | Migration v3 $\to$ v4 Data Preservation | Database v3 có sẵn dữ liệu toàn bộ 8 stores: nâng lên v4 bảo toàn 100% dữ liệu cũ, thêm store thứ 9 rỗng. | **PASS** (11ms) |
| **ST-07C** | Multi-Tab Versionchange Handling | `dbInstance` đóng an toàn và bị nullified khi nhận event `versionchange`. | **PASS** (1ms) |
| **ST-07D** | Real Multi-Connection Upgrade Handshake | Kết nối thực v3 nhận `onversionchange`, tự đóng an toàn, cho phép kết nối v4 nâng cấp thành công mà không bị block. | **PASS** (1ms) |
| **ST-10A** | Baseline Default UNINITIALIZED on Rev 0 | Account mới với checkpoint "0" hoặc thiếu `sync_meta`: `authoritativeBaselineStatus` là `UNINITIALIZED`. | **PASS** (3ms) |
| **ST-10B** | Baseline UNINITIALIZED on Rev > 0 | Nâng cấp từ v3 có checkpoint "150": `authoritativeBaselineStatus` tự động là `UNINITIALIZED`. | **PASS** (1ms) |
| **ST-10C** | Fail-Closed Admission Guard | `isAuthoritativeReady` trả về `false` khi `UNINITIALIZED` hoặc `BOOTSTRAPPING`; chỉ `true` khi có bản ghi `READY` hợp lệ trong storage. | **PASS** (2ms) |
| **ST-10D** | Interrupted Bootstrap Recovery | Scope ở `BOOTSTRAPPING` sau crash/reload: Reconciler nhận diện chưa `READY` và cho phép reset an toàn về `UNINITIALIZED`. | **PASS** (2ms) |
| **ST-10E** | Scope Isolation & Guest Guard | Thao tác baseline trên `account:usr-alpha` không ảnh hưởng `guest:dev-beta` hay `account:usr-gamma`. | **PASS** (2ms) |
| **ST-10F** | Shadow CRUD Primitives | Thao tác `put`, `get` exact key, `get` by domain, và `delete` trên store thứ 9 (`sync_authoritative_replicas`). | **PASS** (5ms) |
| **ST-10G** | PurgeScope Wipes All 9 Stores | `purgeScope` dọn sạch toàn bộ 9 stores cho target scope, bảo toàn 100% dữ liệu 9 stores của keep scope. | **PASS** (7ms) |
| **ST-10H** | Negative Admission & Checkpoint Immutability | Cấm chuyển thẳng sang `READY` qua `setAuthoritativeBaselineStatus`; cấm bypass qua `putSyncMeta`; cấm sửa checkpoint & epoch trên READY scope; cho phép benign update; hỗ trợ legitimate empty-account tại rev 0; xác nhận zero premature finalizers trong production DAL. | **PASS** (10ms) |
| **ST-10I** | Bootstrap Durability Across Connection Reopen | Trạng thái `BOOTSTRAPPING` lưu bền vững qua `dbClient.close()` và khởi tạo `IndexedDbClient` mới; duy trì fail-closed `isAuthoritativeReady = false`. | **PASS** (2ms) |

---

## 9. Đặc Tả & Ma Trận Kiểm Thử Bước 5.2b (Authoritative Shadow DAL, OCC Delta Ingestion & Remediation)

File kiểm thử chuyên biệt: `apps/web/src/test/indexed-db-authoritative-delta.spec.ts` (**41/41 tests PASS** — CLOSED / FROZEN CLEAN tại commit `4a78f9c`, Hosted CI `#42053644100`):

| Mã Test | Tên Kịch Bản Kiểm Thử | Yêu Cầu Xác Minh | Kết Quả |
| :--- | :--- | :--- | :--- |
| **ST-01** | Atomic Delta Page Ingestion & Metadata | Ghi nhận delta page gồm BOOKMARK, PROGRESS, PREFERENCE và cập nhật sync_meta (checkpoint, minActiveRevision, timestamp) trong cùng 1 IDB transaction readwrite. | **PASS** (11ms) |
| **ST-05A** | Monotonic Decimal BigInt Ordering | Ingest các delta items có revision tăng dần hợp lệ (ví dụ: '101', '102'). | **PASS** (2ms) |
| **ST-05B** | Regressive Revision Rejection | Từ chối delta page nếu revisions trong trang giật lùi (ví dụ: '105' rồi đến '104') với `InvalidDeltaPayloadError`. | **PASS** (2ms) |
| **ST-08A** | Checkpoint OCC Match | Áp dụng thành công khi `expectedCheckpoint === currentCheckpoint`. | **PASS** (2ms) |
| **ST-08B** | Stale Checkpoint Conflict Rejection | Từ chối delta page với `CheckpointConflictError` khi expectedCheckpoint khác currentCheckpoint trong storage. | **PASS** (2ms) |
| **ST-08C** | Regressive Target Checkpoint Rejection | Từ chối delta page với `InvalidDeltaPayloadError` nếu targetCheckpoint < currentCheckpoint. | **PASS** (1ms) |
| **ST-09A** | Non-Numeric Revision Rejection | Từ chối payload có revision là chuỗi ký tự không phải số ('abc') với `InvalidDeltaPayloadError`. | **PASS** (1ms) |
| **ST-09B** | Negative Revision Rejection | Từ chối payload có revision số âm ('-1') với `InvalidDeltaPayloadError`. | **PASS** (1ms) |
| **ST-09C** | Floating-Point Revision Rejection | Từ chối payload có revision số thập phân ('10.5') với `InvalidDeltaPayloadError`. | **PASS** (2ms) |
| **ST-11A** | Story-Wide HISTORY DELETE Cascading Eviction | Khi nhận HISTORY DELETE cho story-1 kèm epoch 2: xóa sạch mọi chapter history shadow của story-1, xóa story progress shadow của story-1, giữ nguyên story-2; cập nhật `effectiveHistoryEpochs['story-1'] = 2`. | **PASS** (4ms) |
| **ST-11B** | Global HISTORY DELETE Cascading Eviction | Khi nhận HISTORY DELETE toàn cục (sentinel `00000000-0000-0000-0000-000000000000` hoặc alias `all`) kèm epoch 5: xóa sạch toàn bộ chapter history shadows và progress shadows của scope; cập nhật `effectiveHistoryEpochs[sentinel] = 5`. | **PASS** (3ms) |
| **ST-11C** | HISTORY DELETE Missing Epoch Rejection | Từ chối delta item HISTORY DELETE nếu thiếu trường epoch số nguyên dương với `InvalidDeltaPayloadError`. | **PASS** (1ms) |
| **ST-14A** | Transaction Rollback on Failure | Khi transaction gặp lỗi cố ý trước khi commit, toàn bộ thay đổi shadow và sync_meta bị rollback 100%, checkpoint giữ nguyên. | **PASS** (2ms) |
| **ST-14B** | Authority Admission Boundary Guard | Synchronous admission guard kiểm tra sau `await getDatabase()`: nếu caller bị thu hồi thẩm quyền, abort ngay lập tức trước khi mở transaction. | **PASS** (1ms) |
| **ST-10H-Ext** | putSyncMeta Protection on READY Scope | Kiểm tra `putSyncMeta` khóa bất biến `minActiveRevision`, checkpoint và `effectiveHistoryEpochs` trên READY scope; so sánh epoch map không phụ thuộc thứ tự key qua `areEpochMapsEqual`. | **PASS** (2ms) |
| **ST-10-Pres** | Baseline UNINITIALIZED Preservation | Ingestion delta page cập nhật checkpoint nhưng tuyệt đối KHÔNG cấp trạng thái READY (giữ nguyên UNINITIALIZED / BOOTSTRAPPING). | **PASS** (2ms) |
| **P0-01A** | Mandatory expectedCheckpoint Required | Ném `InvalidDeltaPayloadError` với `MANDATORY_OCC_CHECKPOINT_REQUIRED` khi `expectedCheckpoint` bị bỏ sót hoặc undefined. | **PASS** (1ms) |
| **P0-01B** | Malformed expectedCheckpoint Rejection | Ném `InvalidDeltaPayloadError` khi `expectedCheckpoint` là chuỗi phi số ('abc', '-1', '1.5'). | **PASS** (1ms) |
| **P0-01C** | Checkpoint Conflict on Storage Mismatch | Ném `CheckpointConflictError` khi `expectedCheckpoint` khác `currentCheckpoint` trong IndexedDB. | **PASS** (2ms) |
| **P0-02A** | Inconsistent hasMore vs nextRevision | Ném `InvalidDeltaPayloadError` với `INCONSISTENT_DELTA_PAGE` khi `hasMore === true` nhưng `nextRevision` là null hoặc thiếu. | **PASS** (1ms) |
| **P0-02B** | Inconsistent Stale Change Revision | Ném `InvalidDeltaPayloadError` khi item revision `<= expectedCheckpoint` (thay đổi cũ đã sync). | **PASS** (2ms) |
| **P0-02C** | Inconsistent Change Exceeding Target | Ném `InvalidDeltaPayloadError` khi item revision `> targetCheckpoint`. | **PASS** (1ms) |
| **P0-02D** | Target Checkpoint Exceeding Server Rev | Ném `InvalidDeltaPayloadError` khi `targetCheckpoint > currentServerRevision`. | **PASS** (1ms) |
| **P0-02E** | Compacted Retention Gap Guard | Ném `InvalidDeltaPayloadError` với `COMPACTED_RETENTION_GAP` khi checkpoint client > 0 rơi ra sau `minActiveRevision` server (cần full 410 resync). | **PASS** (2ms) |
| **P0-03A** | Empty Changes Array on hasMore=true | Ném `InvalidDeltaPayloadError` khi `hasMore=true` nhưng mảng `changes` rỗng. | **PASS** (1ms) |
| **P0-03B** | Cursor Overshoots Last Change Revision | Ném `InvalidDeltaPayloadError` khi `hasMore=true` nhưng `nextRevision` vượt quá revision của change cuối cùng (ngăn ngừa bỏ sót delta 102..150). | **PASS** (2ms) |
| **P0-03C** | Cursor Lags Behind Last Change Revision | Ném `InvalidDeltaPayloadError` khi `hasMore=true` nhưng `nextRevision < lastChange.revision`. | **PASS** (1ms) |
| **P0-03D** | Trailing Non-Null Cursor on hasMore=false | Ném `InvalidDeltaPayloadError` khi `hasMore=false` nhưng `nextRevision !== null` (tuân thủ hợp đồng Core API). | **PASS** (2ms) |
| **P0-03E** | Exact Cursor Match Acceptance (hasMore=true) | Chấp thuận checkpoint cập nhật chính xác theo `nextRevision` khi trùng khớp với change cuối cùng của trang. | **PASS** (2ms) |
| **P0-03F** | Catchup Checkpoint Acceptance (hasMore=false) | Chấp thuận checkpoint cập nhật lên `currentServerRevision` khi trang cuối cùng kết thúc với `nextRevision=null`. | **PASS** (2ms) |
| **P0-03G** | Atomic Rollback on Cursor Invalidation | Xác minh rollback toàn vẹn: khi cursor sai lệch, checkpoint và shadow trước đó được bảo toàn 100%, không sinh dirty state. | **PASS** (2ms) |
| **P1-01A** | Global HISTORY DELETE Monotonic Epoch | Từ chối global delete khi incoming epoch `<= currentGlobalEpoch` với `NON_MONOTONIC_HISTORY_EPOCH`. | **PASS** (2ms) |
| **P1-01B** | Story HISTORY DELETE Monotonic Epoch | Từ chối story delete khi incoming epoch `<= currentStoryEpoch` với `NON_MONOTONIC_HISTORY_EPOCH`. | **PASS** (2ms) |
| **P1-01C** | Story HISTORY DELETE vs Global Dominance | Từ chối story delete khi incoming epoch `<= currentGlobalEpoch` với `NON_MONOTONIC_HISTORY_EPOCH`. | **PASS** (2ms) |
| **P1-01D** | Intra-Page Monotonic Epoch Progression | Từ chối delta page chứa các delete cùng truyện có epoch không tăng dần (`newEpoch <= prevEpoch`). | **PASS** (1ms) |
| **P1-01E** | Monotonic Epoch Progression Acceptance | Chấp thuận các epoch tăng dần liên tục và ghi nhận atomically vào `effectiveHistoryEpochs`. | **PASS** (2ms) |
| **P1-02A** | Concurrent OCC Race Conflict & Full Shadow Verification | 2 transaction đồng quy cùng `expectedCheckpoint`: đúng 1 thành công, transaction thứ hai fail `CheckpointConflictError`, kiểm chứng đầy đủ shadow record người thắng tồn tại và người thua không tồn tại. | **PASS** (3ms) |
| **P1-02B** | Two Independent IndexedDbClient Instances Race | Hai instance `IndexedDbClient` hoàn toàn độc lập truy cập cùng database: đúng 1 transaction thắng, 1 transaction dính OCC conflict, zero dirty shadow từ loser. | **PASS** (3ms) |
| **P1-02C** | Delayed-Commit Interleaving with Deterministic Coordination | Điều phối barrier xác định: client B khởi tạo yêu cầu với `expectedCheckpoint` cũ (`'50'`) trong lúc transaction A đang in-flight trước khi commit (không chứng minh B đã thực sự đọc metadata từ IndexedDB trước khi A commit); transaction B bị chặn đứng bởi `CheckpointConflictError` và rollback sạch sẽ. | **PASS HOSTED** |
| **P1-02D** | Multi-Scope Concurrent Isolation | Ingestion đồng thời trên 2 scope khác nhau thành công 100% không ảnh hưởng checkpoint hoặc shadow của nhau. | **PASS** (3ms) |
| **P1-02E** | Concurrent Read Consistency | Đọc shadow trong và sau transaction thất bại luôn trả về dữ liệu committed sạch, không bao giờ đọc dirty state. | **PASS** (2ms) |

---

## 10. Đặc Tả & Ma Trận Kiểm Thử Bước 5.2c & `P1-01` Controlled Unlock (`a695a1e` / Hosted CI `#42608246872` — `READY` LOCKED, KHÔNG TỰ ĐÓNG `FROZEN CLEAN`)

Thành phần triển khai tại `apps/web/src/lib/`:
- [`causal-projection-engine.ts`](file:///e:/Workspace2/Doctruyen_project/apps/web/src/lib/sync/causal-projection-engine.ts): Hàm thuần túy `resolveCausalProjection(AuthoritativeShadow, PendingMutations, OptionalGrace)` bất biến theo hoán vị mảng và độc lập với RAM event / lịch sử tab; chuẩn hóa key qua `getCanonicalEntityKey` (`UUID_SENTINEL` / `'all'` / `${storyId}:${chapterId}`), tính `getEffectiveHistoryEpoch`, bảo vệ kép tombstone/epoch (Revision 2.2 P0-03, P0-05), cửa sổ `GraceProjectionEntry` có giới hạn TTL / catch-up retirement + **P2-01 fail-closed** khi thiếu/NaN `nowMs` (P0-04), và **P1-02** chỉ bảo vệ `protectedProgressKeys`/`protectedHistoryKeys` khi entity thắng cuộc mang `source === 'PENDING'`.
- [`projection-hydrator.ts`](file:///e:/Workspace2/Doctruyen_project/apps/web/src/lib/sync/projection-hydrator.ts): `SyncProjectionHydrator` & `hydrateProjectionFromIndexedDb` đọc nhất quán **8 stores** (`sync_meta`, `sync_authoritative_replicas`, `sync_tombstones`, `pending_mutations`, `bookmarks`, `progress`, `history`, `preferences`) trong **1 IndexedDB transaction duy nhất** và hợp nhất đơn điệu `STORE_TOMBSTONES` qua `mergeTombstoneRevisions` (`BigInt`); fail-closed vào `DEGRADED_COMPATIBILITY` khi `authoritativeBaselineStatus !== 'READY'`; siết `Number.isFinite` ở `recordAppliedGrace` / `getPrunedGraceEntries`; cung cấp `materializeToLegacyStores` trong 1 `readwrite` transaction bảo toàn concurrent winning writes (`ST-15`), cập nhật legacy cũ khi Shadow thắng (`P1-02`), và kích hoạt `checkAdmission` pre-tx + pre-commit (`tx.abort()` rollback).
- [`indexed-db-client.ts`](file:///e:/Workspace2/Doctruyen_project/apps/web/src/lib/storage/indexed-db-client.ts) (`DB_VERSION = 5`, Store #10 `STORE_TOMBSTONES` — Controlled Unlock tại `a695a1e`): Nâng cấp `v4 -> v5` bảo toàn 100% 9 stores cũ, ép reset mọi `READY`/`BOOTSTRAPPING` về `UNINITIALIZED`, giữ khóa `ReadyStatusTransitionForbiddenError`; giữ delete lineage `DELETE@80 -> UPSERT@85`, sửa FIFO cursor hazard (`Phase B`), temporary compatibility epoch inference cho epoch-less `PROGRESS` (giữ explicit `0` fail-closed), atomic 4-store bounded GC `gcAuthoritativeTombstones`, và `purgeScope` xóa đủ 10 stores.

File kiểm thử chuyên biệt:
- `apps/web/src/test/causal-projection-engine.spec.ts` (**23/23 tests PASS HOSTED** — Run `#42608246872` / Commit `a695a1e`)
- `apps/web/src/test/indexed-db-v5-migration.spec.ts` (**15/15 tests PASS HOSTED** — `P1-01-R1`–`R8`, Run `#42608246872` / Commit `a695a1e`)

| Mã / Nhóm Test | Kịch Bản Kiểm Thử | Yêu Cầu Xác Minh | Kết Quả |
| :--- | :--- | :--- | :--- |
| **Pure Helpers (3 tests)** | Canonical Keys, Effective Epoch, Permutation Invariance | Chuẩn hóa key đa dạng (`storyId`, `chapterId`, `'all'`, UUID sentinel), `max(storyEpoch, globalEpoch)`, hoán vị ngược mảng shadows & pending cho kết quả giống hệt 100%. | **PASS HOSTED** |
| **Progress Intent & Catalog (2 tests)** | Cross-Chapter / `forceRewind` & `needsHydration` | Hỗ trợ chuyển chương / `forceRewind` theo ý đồ mới nhất của user; giữ `max(%)` cùng chương nếu không `forceRewind`; gắn cờ `needsHydration` và hợp nhất catalog metadata. | **PASS HOSTED** |
| **Dual-Layer Tombstones (3 tests)** | Epoch Suppression, `P0-05` BaseRev Guard & Bookmark/Delete | Lọc `epoch < effective`, giữ lại `4 === 4`; chặn pending thiếu epoch có `baseServerRevision < tombstoneRevision`; chặn bookmark resurrection & thực thi chronological HISTORY DELETE (nay đã bền vững qua reload với IDB v5 `STORE_TOMBSTONES`). | **PASS HOSTED** |
| **Grace, `P2-01` & IDB Catch-Up + Degraded Mode (4 tests)** | Bounded Grace (`P0-04`), `P2-01` Fail-Closed `nowMs`, IDB Catch-Up/TTL & `DEGRADED_COMPATIBILITY` | Duy trì `GRACE` sau receipt `APPLIED`; **P2-01** fail-closed (`activeGraceCount: 0`) khi thiếu/`NaN` `nowMs`; tích hợp `recordAppliedGrace -> applyAuthoritativeDeltaPage` catch-up `'SHADOW'` & TTL pruning/eviction; hạ cấp về legacy stores khi `baseline !== 'READY'`. | **PASS HOSTED** |
| **ST-02, ST-03, ST-04, ST-06, ST-12, ST-13 (6 tests)** | Fallback, Step 4 Isolation, Merge, Tenant Isolation, Canonical Key & Reload Determinism | Evict pending khôi phục Shadow; Step 4 không chạm shadow/tombstone; `max(progress)`; tách biệt đa scope; chuẩn hóa key `storyId:chapterId`; reload 1 transaction ra kết quả giống hệt 100% và SSR guard. | **PASS HOSTED** |
| **ST-15 + `P1-02` + `checkAdmission` (3 tests)** | Concurrent Local Write, `P1-02` Protected Keys Fix & Pre/Mid-Tx Rollback | Bảo toàn concurrent local writes (`ST-15`); **P1-02** cập nhật legacy cũ `40%/30% → 60%/80%` khi Shadow thắng nhưng giữ bảo vệ concurrent winning write `88%`; `checkAdmission` pre-tx và mid-tx `tx.abort()` rollback nguyên tử không làm bẩn legacy stores. | **PASS HOSTED** |
| **5.2b + Reload & SSR (2 tests)** | Step 5.2b `applyAuthoritativeDeltaPage` + Reload & SSR Guard | Tích hợp delta `HISTORY DELETE` (tăng epoch) -> reload -> chặn stale pending epoch 0, chấp thuận read mới epoch 1, dọn pending DELETE; ném `IndexedDbUnavailableError` khi thiếu `window`/IndexedDB. | **PASS HOSTED** |
| **`P1-01-R1`–`R8` (15 tests in `v5-migration.spec.ts`)** | Durable `STORE_TOMBSTONES`, Lineage `DELETE@80 -> UPSERT@85`, Compat Inference, Bounded GC, `v4 -> v5` Reset & `BigInt` | Chặn stale non-epoch/epoch-less `baseRev=70` qua reload không cần caller options; giữ lineage `DELETE@80 -> UPSERT@85` (tx 8 stores); FIFO cursor fix + compat inference (explicit `0` fail-closed); GC 4-store atomic & fail-closed; `v4 -> v5` reset `UNINITIALIZED` + `purgeScope` 10 stores; `BigInt > MAX_SAFE_INTEGER`. *(Ghi chú Audit: còn `[P1-A]` `requeue` chưa chặn `DISCARDED` và `[P1-B]` post-GC stale `baseRev=70` chưa được `SyncProjectionHydrator` lọc qua `minActiveRevision` / chưa test trong `R5`.)* | **PASS HOSTED (P1 NOTES FOR STEP 6)** |

> **Ràng Buộc `READY` & Step 6 / Cross-Platform:** Khóa `ReadyStatusTransitionForbiddenError` **tiếp tục được giữ nguyên** tại `a695a1e`. Tuyệt đối không bật `authoritativeBaselineStatus = 'READY'` cho tới khi hoàn tất **Step 6** (`snapshot-reconciler.ts`, triage hàng đợi pre-v5/stale) cùng các hợp đồng Core API bổ sung (`SyncSnapshotResponseDto` kèm global epoch sentinel & biên tombstone/cutoff, `StoriesService.recordReadingProgress` phát `observedHistoryEpoch` cho `PROGRESS`, `PreferenceConflictResolver` đối soát `tombstoneRevision`, và Core API GC worker). Chi tiết Ma trận C1–C8 và R1–R8 xem tại [`plans/phase_07c_3_web_sync_reconciler_plan.md`](./phase_07c_3_web_sync_reconciler_plan.md#L290).

---

## 11. Kết Luận

Tài liệu **Storage Coexistence Revision 2.2** đã được hiện thực hóa qua các giai đoạn:
1. **Bước 5.2a (IndexedDB v4 Migration & Baseline Lifecycle Remediation):** Nghiệm thu chính thức (`APPROVED — FROZEN CLEAN`) tại commit `a1c6f4e` với 20/20 regression tests PASS và Hosted CI Run `#41485048616` (`7/7 PASS`).
2. **Bước 5.2b (Authoritative Shadow DAL & OCC Delta Ingestion Final Remediation):** Nghiệm thu chính thức (`APPROVED — CLOSED / FROZEN CLEAN`) tại baseline `4a78f9c`, Hosted CI Run `#42053644100` (`7/7 jobs PASS`), **41/41 tests PASS** (`indexed-db-authoritative-delta.spec.ts`), **827/827 Web Vitest PASS**, TypeScript 0 lỗi, Next.js 16 build Turbopack SUCCESS. Security Gate sử dụng `exit-code: 1` + validator `12/12 PASS` kết hợp **55 CVE IDs** trong `deploy/security/trivy/ai-worker.trivyignore` theo chính sách chấp nhận rủi ro có thời hạn `SEC-REG-6.4.4A` (hạn rà soát **2026-12-01** — không phải đã loại bỏ lỗ hổng upstream); VPS job là Docker Compose topology validation vì chưa cấu hình `VPS_SSH_HOST`/`VPS_SSH_KEY`. Giữ nguyên 100% `mutation-queue.ts`.
3. **Bước 5.2c + P1-01 Controlled Unlock (Pure Deterministic Causal Projection Engine, 8-Store Hydration & Durable `STORE_TOMBSTONES` IDB v5 — IMPLEMENTED AT `a695a1e` / HOSTED CI `#42608246872` 7/7 PASS — FINAL GATE VERIFICATION, `READY` LOCKED, KHÔNG TỰ ĐÓNG `FROZEN CLEAN`):** Toàn bộ `causal-projection-engine.ts`, `projection-hydrator.ts` và Controlled Unlock (`DB_VERSION = 5`, `STORE_TOMBSTONES`, `gcAuthoritativeTombstones`, FIFO cursor cascade fix) trong `indexed-db-client.ts` đã vượt qua **23/23** `causal-projection-engine.spec.ts` + **15/15** `indexed-db-v5-migration.spec.ts` (`P1-01-R1`–`R8`) + **58/58 suites / 865/865 Web Vitest PASS** (xác minh cả local lẫn Hosted CI `#42608246872`), Playwright **31/31 PASS**, ESLint/`tsc` (0 lỗi)/Next.js build (`8.8s`) SUCCESS, giữ nguyên **0 thay đổi** tại `mutation-queue.ts`, `tab-leader-election.ts`, `guest-claim-coordinator.ts`, `packages/shared`, `services/api/src`, `apps/mobile`. Tài liệu đối soát được ghi nhận trên nhánh riêng `docs/step-52c-final-gate-closure`; giữ nguyên khóa `READY`, chưa mở khóa Step 5.2d và theo dõi `[P1-A]` (`DISCARDED` requeue guard), `[P1-B]` (lọc `minActiveRevision` hậu GC + test R5), `[P2-A/B]` cùng các phụ thuộc Core API/Step 6 trước khi bật `READY` hay Reader UI integration.
