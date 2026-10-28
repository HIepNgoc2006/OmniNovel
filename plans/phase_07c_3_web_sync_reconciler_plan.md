# 📋 Kế Hoạch Triển Khai Task 7C.3 — Web Client Sync Reconciler (`apps/web`)

> **Trạng thái:** `[/] Đang Triển Khai (AUTHORIZED)`  
> **Cơ sở pháp lý / Baseline nghiệm thu:** Task 7C.2 FROZEN CLEAN tại baseline `4e9c4dbfb96a6b7957090d8a306485333014c550` (Hosted CI Run #40701295336).  
> **Phạm vi:** Trực thuộc **Phase 7C: Unified Multi-Device Sync Engine**. Triển khai bộ đồng bộ Client-Side trên ứng dụng Web Next.js 16 / React 19.

---

## 1. Mục Tiêu & Các Bất Biến Bắt Buộc (Strict Invariants)

Task 7C.3 triển khai trọn vẹn tầng Client-side Sync Engine trên Web (`apps/web`), đồng bộ hai chiều (Bi-directional Sync) với Core API Sync Hub thông qua giao thức Delta Revisions và Safe Snapshot Triage.

### 5 Bất Biến Bắt Buộc:
1. **Không tự động Rebase Mutation Stale:** Khi Server từ chối mutation với `REJECTED_STALE` hoặc phát hiện xung đột không giải quyết được, Web Client **tuyệt đối không tự ý ghi đè/rebase** mutation lên baseServerRevision mới. Mutation bị lỗi sẽ bị đưa vào `quarantined_mutations` và thông báo cho người dùng hoặc đợi chỉ thị rõ ràng.
2. **Bảo Vệ Chống Phục Sinh (Anti-Tombstone Resurrection):** Không cho phép bất kỳ mutation cục bộ nào làm sống lại bản ghi đã bị Server đánh dấu xóa (Tombstone). Cập nhật local replica lập tức xóa bản ghi nếu nhận `REJECTED_TOMBSTONE` hoặc gặp Delta `DELETE`.
3. **Tính Nguyên Tử Của Checkpoint (Checkpoint Atomicity):** Checkpoint revision (`lastSyncedServerRevision`) chỉ được phép tăng lên **SAU KHI** toàn bộ các thay đổi trong batch delta hoặc snapshot đã được ghi thành công (committed) vào IndexedDB trong cùng một transaction/bước nguyên tử. Tuyệt đối không ghi checkpoint trước khi local apply thành công.
4. **Phân Định Rõ Ràng Ngữ Nghĩa Epoch:**
   - Miền **HISTORY**: Áp dụng kiểm tra đẳng thức nghiêm ngặt (`mutation.storyHistoryEpoch === server.storyHistoryEpoch`).
   - Miền **PROGRESS**: Áp dụng kiểm tra bảo vệ causal epoch với quan hệ `< effectiveHistoryEpoch` (cho phép tiến trình đọc mới nếu client đã quan sát revision xóa lịch sử).
5. **Cách Ly Đa Tab & Leader Election:** Chỉ một tab duy nhất (Tab Leader) được quyền thực thi kết nối mạng kéo/đẩy sync với Core API thông qua bầu chọn `BroadcastChannel` với cơ chế Heartbeat & Lease Timeout. Các tab khác hoạt động ở chế độ Follower và nhận thông báo cập nhật qua bus nội bộ.

---

## 2. Cấu Trúc Thành Phần & File Mapping

```
packages/shared/src/
├── types/
│   └── sync.types.ts                 <-- [Mới] Canonical Shared Sync Contracts (DTOs, Enums, Payloads)
apps/web/src/lib/
├── storage/
│   ├── indexed-db-client.ts          <-- [Nâng cấp] DB_VERSION 3, bổ sung 4 object stores
│   └── sync-storage.ts               <-- [Mới] Data Access Layer cho Sync stores trong IndexedDB
└── sync/
    ├── web-sync.types.ts             <-- [Mới] Client-specific sync interfaces & state machine
    ├── tab-leader-election.ts        <-- [Mới] Điều phối đa tab qua BroadcastChannel & Web Locks API
    ├── mutation-queue.ts             <-- [Mới] Quản lý pending mutations, deduplication & quarantine
    ├── delta-pull-reconciler.ts      <-- [Mới] Kéo /sync/changes và apply nguyên tử vào local stores
    ├── snapshot-reconciler.ts        <-- [Mới] Xử lý Safe 410 Gone Full Resync với Snapshot Staging
    ├── web-sync-coordinator.ts       <-- [Mới] Facade điều phối toàn bộ chu trình sync (Online/Offline/Periodic)
    └── index.ts                      <-- [Mới] Public exports cho UI & Hooks
```

---

## 3. Thiết Kế Chi Tiết Từng Module

### 3.1. Nâng Cấp Schema IndexedDB (v1/v2 -> v3)
- **Object Stores Mới:**
  1. `sync_meta`: Key-value store lưu trữ trạng thái đồng bộ:
     - `lastSyncedServerRevision`: Revision cao nhất đã apply cục bộ an toàn.
     - `minActiveRevision`: Ngưỡng GC server thông báo gần nhất.
     - `lastSyncTimestamp`: Thời điểm sync thành công gần nhất.
     - `effectiveHistoryEpochs`: Map `{ [storyId: string]: number }` lưu epoch lịch sử của từng truyện.
     - `syncState`: `'IDLE' | 'PULLING' | 'PUSHING' | 'RECONCILING_410' | 'ERROR'`.
  2. `pending_mutations`: Lưu các mutation do hành động đọc/bookmark cục bộ phát sinh khi offline hoặc chờ gửi:
     - KeyPath: `mutationId` (UUIDv4)
     - Indexes: `by_createdAt`, `by_domain_entity` (`[domain, entityId]`)
  3. `quarantined_mutations`: Lưu các mutation bị server từ chối (`REJECTED_STALE`, xung đột logic):
     - KeyPath: `mutationId`
     - Metadata: `rejectionReason`, `rejectedAt`, `originalPayload`
  4. `snapshot_staging_store`: Lưu tạm các trang snapshot khi xử lý 410 Gone Full Resync:
     - Giúp việc tải snapshot nhiều trang (paginated) không làm ô nhiễm DB chính trước khi hoàn tất toàn bộ dữ liệu.

### 3.2. Điều Phối Đa Tab (Tab Leader Election)
- Sử dụng `navigator.locks` (Web Locks API) kết hợp `BroadcastChannel('omninovel_sync_channel')`:
  - Web Locks API cung cấp cơ chế loại trừ tương hỗ (Mutual Exclusion) tự nhiên của trình duyệt, tự động giải phóng lock khi tab bị đóng hoặc crash đột ngột.
  - BroadcastChannel phát tín hiệu:
    - `LEADER_CLAIMED`: Báo hiệu tab nào đang là Leader.
    - `SYNC_STATE_CHANGED`: Báo cho các tab follower biết trạng thái sync để cập nhật UI (spinners, last sync time).
    - `LOCAL_DATA_MUTATED`: Thông báo khi Tab Leader vừa apply delta vào IndexedDB để các tab khác re-render React Query cache.
    - `FORCE_SYNC_REQUESTED`: Follower yêu cầu Leader kích hoạt chu trình sync ngay lập tức.

### 3.3. Hàng Đợi Mutation (Mutation Queue & Push Worker)
- Khi người dùng đọc truyện / thêm bookmark:
  1. Ghi cục bộ vào store tương ứng (`bookmarks`, `progress`, `history`).
  2. Đồng thời ghi một `ClientMutation` vào store `pending_mutations` với `baseServerRevision = lastSyncedServerRevision`.
  3. Tab Leader đọc batch (tối đa 50 mutations), gửi `POST /api/v1/sync/mutations/batch`.
  4. Khi nhận kết quả từ Server:
     - `APPLIED` / `DEDUPLICATED`: Xóa mutation khỏi `pending_mutations`.
     - `CONFLICT_MERGED`: Xóa khỏi `pending_mutations`, áp dụng dữ liệu hợp nhất vào local store.
     - `REJECTED_TOMBSTONE`: Xóa khỏi `pending_mutations`, xóa ngay bản ghi tương ứng khỏi local store để chống phục sinh.
     - `REJECTED_STALE`: Chuyển mutation sang `quarantined_mutations`. **Tuyệt đối không tự ý rebase.**

### 3.4. Bộ Kéo Delta (Delta Pull Reconciler)
- Gửi `GET /api/v1/sync/changes?after=${lastSyncedServerRevision}`:
  - Nếu Server trả về `changes`:
    - Mở một IDBTransaction `readwrite` trên tất cả các stores liên quan (`bookmarks`, `progress`, `history`, `sync_meta`).
    - Lần lượt áp dụng các thay đổi:
      - `BOOKMARK` `UPSERT` / `DELETE`
      - `PROGRESS` `UPSERT`: áp dụng Monotonic rule (chỉ cập nhật nếu tiến độ mới hơn và thỏa mãn guard epoch).
      - `HISTORY` `UPSERT` / `DELETE` (nếu `DELETE`: cập nhật `effectiveHistoryEpochs`).
    - **Cập nhật Checkpoint:** Ghi `lastSyncedServerRevision = batch.currentServerRevision` vào `sync_meta` **BÊN TRONG** chính transaction này.
    - Transaction `oncomplete` -> Phát tín hiệu qua BroadcastChannel cho các tab follower.

### 3.5. Xử Lý Phục Hồi Toàn Diện (Safe 410 Gone Full Resync Reconciler)
- Khi Server trả về HTTP `410 Gone` (client checkpoint nhỏ hơn `minActiveRevision` do GC dọn dẹp):
  1. **Chuyển trạng thái:** Đặt cờ `syncState = 'RECONCILING_410'`, chặn tạm thời các thao tác push mới.
  2. **Stage Snapshot:** Tải từng trang của snapshot qua `GET /api/v1/sync/snapshot` và nạp vào `snapshot_staging_store`.
  3. **Atomic Swap & Triage:**
     - Mở transaction trên toàn bộ các stores.
     - Quét `pending_mutations`: Giữ lại các mutation hợp lệ (chưa bị ghi đè trong snapshot), cô lập các mutation xung đột vào `quarantined_mutations`.
     - Thay thế dữ liệu local bằng dữ liệu từ snapshot staging.
     - Áp dụng các pending mutations còn hợp lệ lên trên snapshot mới.
     - Cập nhật `lastSyncedServerRevision = snapshotRevision`.
     - Xóa sạch `snapshot_staging_store`.
     - Đặt lại `syncState = 'IDLE'`.

---

## 4. Kế Hoạch Kiểm Thử Tự Động (Test Matrix & Verification)

1. **Unit Tests (Vitest in `apps/web`):**
   - Nâng cấp schema IndexedDB v1/v2 -> v3 (giữ nguyên dữ liệu cũ, khởi tạo các store mới).
   - Enqueue, dequeue, batching, quarantine của `MutationQueue`.
   - Bầu chọn Tab Leader qua BroadcastChannel & Web Locks API (giả lập nhiều context/tab).
   - Delta Pull Reconciler: Áp dụng UPSERT/DELETE, tombstone guard, cập nhật checkpoint nguyên tử.
   - Snapshot Reconciler: Xử lý 410 Gone, staging nhiều trang, atomic swap, triage pending mutations.
2. **Integration & Concurrency Tests:**
   - Đa tab mô phỏng: 1 Leader + 2 Followers cùng đọc và đồng bộ.
   - Offline -> Online transitions: Tích lũy mutation khi mất mạng, tự động flush khi có mạng.
   - Kịch bản Anti-Resurrection: Client offline có bookmark cũ, Server đã xóa -> Khi online lại, client tự xóa local, không làm sống lại bookmark.
   - Kịch bản Safe 410 Gone: Checkpoint cũ bị GC -> Nhận 410 -> Kéo Snapshot -> Staging -> Swap thành công.
3. **Build & Hosted CI:**
   - `npm run test` (Vitest) toàn bộ Web suite pass 100%.
   - `npm run build` (Next.js 16) pass không lỗi kiểu TypeScript.
   - Hosted CI 7/7 Jobs Green.

---

## 5. Tiến Độ Triển Khai Chi Tiết (Step-by-Step Execution Plan)

- [ ] **Bước 1:** Khởi tạo canonical types trong `packages/shared/src/types/sync.types.ts` và export qua `packages/shared`.
- [ ] **Bước 2:** Nâng cấp `apps/web/src/lib/storage/indexed-db-client.ts` lên `DB_VERSION = 3`, thêm các object stores mới và viết unit test migration.
- [ ] **Bước 3:** Cài đặt `apps/web/src/lib/sync/tab-leader-election.ts` quản lý bầu chọn Leader đa tab.
- [ ] **Bước 4:** Cài đặt `apps/web/src/lib/sync/mutation-queue.ts` quản lý hàng đợi, chống rebase bừa bãi và cách ly quarantined mutations.
- [ ] **Bước 5:** Cài đặt `apps/web/src/lib/sync/delta-pull-reconciler.ts` kéo changes và áp dụng checkpoint nguyên tử.
- [ ] **Bước 6:** Cài đặt `apps/web/src/lib/sync/snapshot-reconciler.ts` xử lý Safe 410 Gone Full Resync với staging.
- [ ] **Bước 7:** Tích hợp `apps/web/src/lib/sync/web-sync-coordinator.ts` và gắn kết với Auth/Identity/Reader hooks.
- [ ] **Bước 8:** Chạy kiểm thử toàn diện (Vitest, Next.js build), xác minh các kịch bản nghiệm thu và đẩy Git đồng bộ.
