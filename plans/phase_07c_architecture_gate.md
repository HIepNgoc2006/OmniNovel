# 🏛️ OmniNovel Architecture Gate: Phase 7C.0 — Unified Multi-Device Sync Engine
> **Document Status:** SPECIFICATION AMENDMENTS — ARCHITECTURE REVIEW GATE  
> **Milestone:** Phase 7C — Task 7C.0  
> **Review Outcome:** CONDITIONAL PASS (All P0/P1 Design Amendments Integrated)  
> **Target Subsystems:** `services/api`, `packages/shared`, `apps/web`, `apps/mobile`  
> **Date:** 2026-10-28  
> **Author:** OmniNovel Engineering Core

---

## 1. Executive Summary & Design Philosophy

OmniNovel cung cấp nền tảng đọc truyện đa phương thức (Webtoon, Manga, Light Novel) liền mạch giữa Trình duyệt Web (Next.js) và Ứng dụng Di động (Flutter). Khi người dùng đọc trên nhiều thiết bị hoặc mở nhiều tab đồng thời, trạng thái thư viện (Bookmark, Tiến độ đọc từng trang/khối neo, Lịch sử chương, Cài đặt cá nhân) phải đạt tính **Eventually Consistent** tin cậy tuyệt đối, không thất thoát dữ liệu, và không bị sai lệch trong môi trường mạng chập chờn hoặc ngoại tuyến dài ngày.

```text
                  ┌─────────────────────────────────────────────────────────┐
                  │                 Core API (PostgreSQL SSoT)               │
                  │   user_sync_state (current_sync_rev: BIGINT "10425")    │
                  │   sync_change_log (Server Revisions 1..10425)           │
                  │   sync_tombstones (Tombstone Horizon: 90 Days)          │
                  │   sync_mutation_receipts (Durable Idempotency Ledger)   │
                  └────────────────────────────┬────────────────────────────┘
                                               │
                               Bi-Directional Delta & Snapshot Protocol
                          (Pull /changes ── Pull /snapshot ── Push /mutations)
                                               │
                       ┌───────────────────────┴───────────────────────┐
                       ▼                                               ▼
         ┌───────────────────────────┐                   ┌───────────────────────────┐
         │     Next.js Web Client    │                   │     Flutter Mobile App    │
         │   Local IndexedDB Replica │                   │    Local SQLite Replica   │
         │   clientId: uuid-web-tab1 │                   │   clientId: uuid-mob-ph1  │
         │   lastRevision: "10425"   │                   │   lastRevision: "10425"   │
         │   BroadcastChannel Leader │                   │   Background SyncWorker   │
         └───────────────────────────┘                   └───────────────────────────┘
```

---

## 2. Khóa 5 Bất Biến Cốt Lõi (5 Hardened Architectural Invariants)

| # | Trụ cột (Pillar) | Bất biến kỹ thuật & Quy tắc bắt buộc | Cơ chế bảo vệ & Chuẩn hóa (Hardening) |
|---|---|---|---|
| **P1** | **Monotonic Server Ordering & Wire Precision** | Server là trọng tài duy nhất cho trật tự thời gian logic. Mọi biến đổi được gán `revision BIGINT` tăng đơn điệu. Tuyệt đối **không tin tưởng đồng hồ client**. Trên đường truyền mạng, revision **phải được biểu diễn dạng Decimal String** để bảo toàn độ chính xác 64-bit của JavaScript (`> 2^53 - 1`). | Cột `BIGINT` trong PostgreSQL; cấp phát qua `FOR UPDATE` trên `user_sync_state`. TypeScript DTO sử dụng `string` cho mọi trường revision. |
| **P2** | **Strict Idempotency with Durable Receipts** | Mọi mutation được định danh duy nhất bởi `(user_id, client_id, mutation_id)`. Mọi kết quả xử lý (bao gồm `APPLIED`, `DEDUPLICATED`, `REJECTED_TOMBSTONE`, `CONFLICT_MERGED`, `REJECTED_STALE`) phải được ghi nhận bền vững vào `sync_mutation_receipts` kèm `payload_hash` (SHA-256). | Bảng riêng `sync_mutation_receipts` trong cùng transaction boundary. Retry cùng payload trả kết quả gốc; retry khác payload trả `409 Conflict`. |
| **P3** | **Domain-Specific Convergence & Contract Parity** | Hòa trộn dữ liệu theo đúng ngữ nghĩa miền. Tái sử dụng hợp đồng Phase 7B: `ReadingMode` chuẩn là `'WEBTOON' \| 'PAGED' \| 'NOVEL'` (cấm dùng `MANGA_PAGED`). `PROGRESS` mang đầy đủ 7-tuple. Tiến độ đọc mang tính đơn điệu tăng (Monotonic Forward), cấm so sánh `pageIndex` mù quáng giữa hai `chapterVersionId` khác layout. | Tái sử dụng DTO từ Phase 7B. Rule: Version layout mismatch fallback an toàn; `forceRewind: true` mới được phép lùi chương. |
| **P4** | **Device Identity & Topology** | Tách bạch 3 định danh: `userId` (SSoT tài khoản) ↔ `sessionId` (`sid` JWT claim) ↔ `clientId` (UUIDv4 bản sao lưu trữ cục bộ). Đa tab Web phối hợp qua `BroadcastChannel` hoặc `navigator.locks` để bầu 1 Leader thực hiện sync, ngăn ngừa bão request. | Sinh `clientId` duy nhất 1 lần khi tạo cơ sở dữ liệu client. Cấm đồng nhất hóa `clientId` giữa các tab độc lập nếu không có leader gate. |
| **P5** | **Tombstones, Anti-Resurrection & Safe Full Resync** | Lệnh xóa sinh Tombstone có `revision`. Khi client nhận `410 SYNC_REVISION_EXPIRED` (offline > 90 ngày), **tuyệt đối KHÔNG tự động rebase pending mutations** sang revision mới. Phải phân loại (triage) và đối chiếu với Cloud Snapshot: Stale UPSERT cho thực thể không còn tồn tại trên Cloud bị hủy/cách ly để triệt tiêu nguy cơ phục sinh zombie data. | Cửa sổ lưu giữ 90 ngày liên kết giữa `sync_tombstones`, `sync_change_log` và `min_active_revision`. Thuật toán Safe Reconcile xử lý 410. |

---

## 3. Đặc Tả Chi Tiết Các Điểm Cải Tiến Bắt Buộc (P0 & P1 Amendments)

### 3.1. [P0 Fix] Thuật Toán Khôi Phục Snapshot & Chống Phục Sinh Dữ Liệu Khi Full Resync

#### Lỗ hổng tiềm ẩn trước đây:
Khi client offline quá 90 ngày, server trả về `410 SYNC_REVISION_EXPIRED`. Nếu client tải snapshot mới về rồi tự động gán lại `baseServerRevision = currentServerRevision` cho các pending mutations cũ, thì một lệnh `UPSERT Bookmark truyện A` (tồn tại từ trước khi truyện A bị xóa trên Web 80 ngày trước) sẽ được gửi lên Cloud như một thao tác mới, làm **phục sinh truyện A ngoài ý muốn**.

#### Thuật Toán Triage & Safe Reconciliation Chuẩn (Bắt buộc cho Web & Mobile):
Khi client nhận `410 Gone / SYNC_REVISION_EXPIRED` (hoặc khi `client.lastRevision < server.minActiveRevision`):
1. **Phong tỏa hàng đợi:** Tạm dừng gửi `pending_mutations`.
2. **Kéo Cloud Snapshot:** Gọi `GET /api/v1/sync/snapshot` để lấy toàn bộ thư viện Cloud hiện tại tại `snapshotRevision`.
3. **Ghi đè Local Replica:** Cập nhật bảng cục bộ (`bookmarks`, `reading_progress`, `chapter_read_states`, `preferences`) theo Cloud Snapshot, đặt `lastRevision = snapshotRevision`.
4. **Phân loại từng Pending Mutation (Triage Matrix):**
   * **Miền `BOOKMARK` & `FOLLOW`:**
     * Thao tác `UPSERT`: Kiểm tra xem thực thể có trong Cloud Snapshot không:
       * *Nếu KHÔNG có trong Cloud Snapshot:* Vì `baseServerRevision < minActiveRevision`, không thể phân biệt được truyện này mới tạo offline hay đã bị xóa trên Cloud và tombstone đã bị GC. Do đó, **HỦY BỎ hoặc CÁCH LY** mutation vào bảng `quarantined_mutations` với lý do `STALE_SNAPSHOT_DISCARDED`. **DELETE luôn thắng stale UPSERT.**
       * *Nếu ĐÃ CÓ trong Cloud Snapshot:* Đánh dấu mutation đã được hòa trộn (ACK), xóa khỏi `pending_mutations`.
     * Thao tác `DELETE`: Nếu thực thể vẫn còn trong Cloud Snapshot, cập nhật `baseServerRevision = snapshotRevision` và đưa vào hàng đợi gửi lên. Nếu Cloud Snapshot cũng không còn, coi như đã hoàn thành.
   * **Miền `PROGRESS`:**
     * Đối chiếu với `reading_progress` trong Cloud Snapshot:
       * Nếu `cloud.chapterIndex > pending.chapterIndex` và `forceRewind !== true`: **HỦY BỎ** tiến độ chương cũ, chỉ giữ lại sự kiện đọc chương vào `chapter_read_states` (lịch sử).
       * Nếu cùng chương và cùng `chapterVersionId`: So sánh `progressPercentage`. Nếu `pending.progressPercentage > cloud.progressPercentage`, cập nhật `baseServerRevision = snapshotRevision` và giữ lại trong hàng đợi.
       * Nếu khác `chapterVersionId`: Không so sánh số trang `pageIndex`; giữ nguyên tiến độ của phiên bản Cloud mới hơn trừ khi người dùng có tương tác đọc rõ ràng.
   * **Miền `HISTORY` (`chapter_read_states`):**
     * Có tính chất cộng dồn (Commutative Append-only). Cập nhật `baseServerRevision = snapshotRevision` và giữ lại trong hàng đợi gửi lên Cloud.
   * **Miền `PREFERENCE`:**
     * Giữ nguyên giá trị nếu người dùng chủ động sửa đổi trong phiên offline gần nhất, cập nhật `baseServerRevision = snapshotRevision`.

---

### 3.2. [P0 Fix] Sổ Cái Biên Nhận Khả Trùng Bền Vững (`sync_mutation_receipts`)

Để đảm bảo tính khả trùng tuyệt đối, kết quả xử lý của **mọi mutation** (kể cả mutation bị từ chối) phải được lưu trữ bền vững trong CSDL:

```sql
CREATE TABLE IF NOT EXISTS sync_mutation_receipts (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id VARCHAR(64) NOT NULL,
    mutation_id UUID NOT NULL,
    payload_hash VARCHAR(64) NOT NULL, -- SHA-256 (canonical JSON không phụ thuộc thứ tự key)
    status VARCHAR(32) NOT NULL,        -- 'APPLIED' | 'DEDUPLICATED' | 'REJECTED_TOMBSTONE' | 'CONFLICT_MERGED' | 'REJECTED_STALE'
    assigned_revision BIGINT,           -- NULL nếu mutation bị từ chối không cấp revision
    response_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, client_id, mutation_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_mutation_receipts_lookup 
    ON sync_mutation_receipts(user_id, client_id, mutation_id);
```

#### Quy Trình Xử Lý Giao Dịch Trong Batch Mutation:
Trong một PostgreSQL Transaction duy nhất cho từng batch (hoặc savepoint cho từng mutation):
1. **Kiểm tra Receipt:** Tra cứu `(user_id, client_id, mutation_id)` trong `sync_mutation_receipts`.
2. **Xử lý Retry:**
   * Nếu tìm thấy receipt:
     * Tính `current_payload_hash = SHA256(canonicalJson(mutation.payload))`.
     * Nếu `current_payload_hash === receipt.payload_hash`:
       ➔ Trả về `status: 'DEDUPLICATED'`, `assignedRevision: receipt.assigned_revision` (dạng string), không thực hiện lại bất kỳ side-effects nào.
     * Nếu `current_payload_hash !== receipt.payload_hash`:
       ➔ Trả về mã lỗi HTTP `409 Conflict` (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`).
3. **Xử lý Mutation Mới:**
   * Kiểm tra điều kiện Tombstone / Stale / Domain rules.
   * Nếu bị từ chối (vd: `REJECTED_TOMBSTONE` hoặc `REJECTED_STALE`):
     * Ghi receipt vào `sync_mutation_receipts` với `status = 'REJECTED_TOMBSTONE'`, `assigned_revision = NULL`.
   * Nếu được chấp thuận:
     * Tăng nguyên tử `user_sync_state.current_sync_revision = current_sync_revision + 1`.
     * Ghi bản ghi vào `sync_change_log` với `revision = current_sync_revision`.
     * Áp dụng thay đổi vào bảng miền nghiệp vụ (`bookmarks`, `reading_progress`, v.v.).
     * Ghi receipt vào `sync_mutation_receipts` với `status = 'APPLIED'` và `assigned_revision = current_sync_revision`.
4. Commit toàn bộ thay đổi.

---

### 3.3. [P0 Fix] Chuẩn Hóa Hợp Đồng Miền Đọc & Đồng Bộ Hóa Phase 7B

* **Kiểu `ReadingMode` chuẩn:** Kế thừa trực tiếp từ Phase 7B canonical enum:
  ```typescript
  export enum ReadingMode {
    WEBTOON = 'WEBTOON',
    PAGED = 'PAGED',     // Tuyệt đối không dùng MANGA_PAGED
    NOVEL = 'NOVEL',
  }
  ```
* **Payload Tiến Độ Đọc (Canonical 7-Tuple):**
  ```typescript
  export interface ProgressMutationPayload {
    storyId: string;
    chapterId: string;
    chapterVersionId?: string | null;
    readingMode: ReadingMode;
    pageIndex: number;            // 1-based (bắt buộc >= 1 khi PAGED)
    scrollPosition: number;       // Tọa độ pixel (WEBTOON)
    progressPercentage: number;   // 0.00 đến 100.00
    anchorBlockId?: string | null;// Neo khối văn bản (NOVEL)
    textOffset?: number | null;   // Offset ký tự trong khối (NOVEL)
    forceRewind?: boolean;        // Cho phép đọc lại chương cũ mà không bị reject
  }
  ```
* **Quy Tắc Hòa Trộn Theo Phiên Bản Chương (Version-Aware Layout Matching):**
  * Không so sánh `MAX(pageIndex)` khi `incoming.chapterVersionId !== cloud.chapterVersionId`. Các phiên bản biên tập khác nhau có thể có số trang và layout ảnh khác nhau.
  * Khi lệch phiên bản, hệ thống bảo tồn tiến độ của phiên bản có timestamp cập nhật mới hơn, hoặc phân tách trạng thái đọc theo phiên bản.

---

### 3.4. [P1 Fix] Chuẩn Hóa Số Nguyên 64-bit (BIGINT Wire Decimal String)

Để ngăn chặn lỗi mất mát độ chính xác của JavaScript (vượt quá `Number.MAX_SAFE_INTEGER = 9,007,199,254,740,991`):
* Mọi trường đại diện cho revision trên đường truyền mạng (JSON DTO) bắt buộc phải là `string` (ví dụ: `"10425"`).
* Tại Backend (NestJS / TypeORM): Cột CSDL là `BIGINT`, Entity sử dụng TypeORM Transformer hoặc `string` DTO để parse sang `BigInt` khi tính toán số học.
* Tại Client (TypeScript / Dart): Web parse `BigInt(str)` hoặc so sánh chuỗi số học; Mobile Dart sử dụng `BigInt.parse(str)`.

---

### 3.5. [P1 Fix] Đặc Tả Phân Trang Delta & Snapshot Consistency

#### Endpoint 1: Kéo Delta (`GET /api/v1/sync/changes`)
* **Query Params:**
  * `after`: `string` (Decimal string biểu diễn revision client đang có, ví dụ `"10420"`).
  * `limit`: `number` (Tùy chọn, mặc định 100, tối đa 500).
* **Response (`200 OK`):**
  ```typescript
  export interface SyncChangesResponseDto {
    currentServerRevision: string;
    minActiveRevision: string;
    nextRevision: string | null; // Null nếu client đã kéo đến revision mới nhất
    hasMore: boolean;
    changes: Array<{
      revision: string;
      domain: 'BOOKMARK' | 'PROGRESS' | 'HISTORY' | 'PREFERENCE' | 'FOLLOW';
      entityId: string;
      operation: 'UPSERT' | 'DELETE';
      payload: Record<string, any>;
      createdAt: string;
    }>;
  }
  ```
* **Checkpoint Boundary tại Client:** Client chỉ được phép cập nhật `lastRevision` cục bộ sau khi đã commit thành công toàn bộ batch delta đó vào transaction của IndexedDB/SQLite.

#### Endpoint 2: Kéo Toàn Bộ Snapshot (`GET /api/v1/sync/snapshot`)
Dùng để khôi phục nhanh hoặc xử lý khi gặp `410 SYNC_REVISION_EXPIRED`:
* **Query Params:**
  * `cursor`: `string` (Tùy chọn, phục vụ phân trang snapshot nếu thư viện lớn).
  * `limit`: `number` (Mặc định 200).
* **Response (`200 OK`):**
  ```typescript
  export interface SyncSnapshotResponseDto {
    snapshotRevision: string;
    minActiveRevision: string;
    hasMore: boolean;
    nextCursor: string | null;
    data: {
      bookmarks: Array<{ storyId: string; createdAt: string }>;
      readingProgress: Array<ProgressMutationPayload>;
      chapterReadStates: Array<{ chapterId: string; maxProgressPercentage: number; completedAt: string | null; lastReadAt: string }>;
      preferences: Array<{ key: string; value: any; updatedAt: string }>;
    };
  }
  ```

---

### 3.6. [P1 Fix] Cơ Chế Ghi Nhận Thay Đổi Cho Các API Hiện Có (Legacy Mutation Emitter)

Mọi thao tác ghi thư viện qua các API hiện có (đặc biệt là **Guest Claim Commit** `POST /claims/commit` và API đánh dấu trang trực tiếp):
1. Không được để các thao tác này bị "tàng hình" đối với các thiết bị khác.
2. Được tích hợp dịch vụ `SyncLogEmitter` thực thi trong **cùng transaction** với lệnh ghi:
   * Khóa hàng `user_sync_state` của user qua `FOR UPDATE`.
   * Tăng `current_sync_revision`.
   * Ghi nhận sự kiện tương ứng vào `sync_change_log` với `clientId: 'system:guest-claim'` hoặc `'system:api'`.
   * Tạo bản ghi receipt trong `sync_mutation_receipts` để bảo toàn tính khả trùng.
3. **Bảo tồn Invariant Không Gamification:** Quá trình sync hoặc emission delta tuyệt đối không kích hoạt phát thưởng kinh nghiệm, OmniCoin, hoặc Streak ($\Delta = 0$).

---

### 3.7. [P1 Fix] Quản Lý Chu Kỳ Sống Của Tombstone & Thủy Triều Revision (GC Watermark)

1. **Chu kỳ sống (Retention Horizon):** 90 ngày.
2. **Quy trình Garbage Collection (Cronjob định kỳ):**
   ```text
   Cutoff Time = NOW() - INTERVAL '90 days'
   New Min Revision = MIN(revision) FROM sync_change_log WHERE created_at >= Cutoff Time
   DELETE FROM sync_tombstones WHERE created_at < Cutoff Time
   DELETE FROM sync_change_log WHERE created_at < Cutoff Time
   UPDATE user_sync_state SET min_active_revision = New Min Revision
   ```
3. **Server Push Guard (Fail-Closed):**
   Nếu client gửi mutation có `BigInt(baseServerRevision) < BigInt(user_sync_state.min_active_revision)`:
   ➔ Server từ chối ngay lập tức với mã lỗi HTTP `410 Gone` / status `REJECTED_STALE`.

---

## 4. Đặc Tả Cơ Sở Dữ Liệu PostgreSQL Đầy Đủ

```sql
-- 1. Quản lý trạng thái revision và watermark của từng người dùng
CREATE TABLE IF NOT EXISTS user_sync_state (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_sync_revision BIGINT NOT NULL DEFAULT 0,
    min_active_revision BIGINT NOT NULL DEFAULT 0,
    last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Nhật ký đồng bộ Delta
CREATE TABLE IF NOT EXISTS sync_change_log (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL,
    client_id VARCHAR(64) NOT NULL,
    mutation_id UUID NOT NULL,
    domain VARCHAR(32) NOT NULL, -- 'BOOKMARK', 'PROGRESS', 'HISTORY', 'PREFERENCE', 'FOLLOW'
    entity_id VARCHAR(128) NOT NULL,
    operation VARCHAR(16) NOT NULL, -- 'UPSERT', 'DELETE'
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_sync_change_log_user_revision UNIQUE (user_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_sync_change_log_pull 
    ON sync_change_log(user_id, revision ASC);

-- 3. Bảng Tombstone bảo vệ chống phục sinh dữ liệu
CREATE TABLE IF NOT EXISTS sync_tombstones (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    domain VARCHAR(32) NOT NULL,
    entity_id VARCHAR(128) NOT NULL,
    deleted_at_revision BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, domain, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_tombstones_user_rev 
    ON sync_tombstones(user_id, deleted_at_revision ASC);

-- 4. Bảng Sổ cái Biên nhận Khả trùng Bền vững
CREATE TABLE IF NOT EXISTS sync_mutation_receipts (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id VARCHAR(64) NOT NULL,
    mutation_id UUID NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL,
    assigned_revision BIGINT,
    response_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, client_id, mutation_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_mutation_receipts_lookup 
    ON sync_mutation_receipts(user_id, client_id, mutation_id);
```

---

## 5. Ma Trận Nghiệm Thu Bắt Buộc (12 Acceptance Scenarios)

| Scenario ID | Tình huống kiểm thử | Hành động & Điều kiện | Kỳ vọng nghiệm thu (Expected Invariant) |
|---|---|---|---|
| **SYNC-01** | Hai thiết bị gửi mutation đồng thời | Web & Mobile cùng gửi batch mutation lên Server tại cùng một thời điểm. | Không bị race condition; PostgreSQL cấp revision tăng đơn điệu không trùng lặp; thứ tự commit hợp lệ. |
| **SYNC-02** | Retry mutation đã `APPLIED` | Client gửi lại mutation đã được xử lý thành công trước đó (cùng ID, cùng payload hash). | Nhận trạng thái `DEDUPLICATED` kèm assigned revision gốc; không sinh side-effects hay tăng revision. |
| **SYNC-03** | Retry mutation đã bị `REJECTED` | Client gửi lại mutation trước đó đã bị `REJECTED_TOMBSTONE` hoặc `REJECTED_STALE`. | Nhận kết quả từ chối ổn định từ `sync_mutation_receipts`; không xử lý lại. |
| **SYNC-04** | Tái sử dụng Mutation ID với Payload khác | Client gửi mutation ID cũ nhưng sửa đổi payload. | Trả lỗi `409 Conflict` (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`); chặn đứng hành vi giả mạo ID. |
| **SYNC-05** | Offline > 90 ngày với pending UPSERT cũ | Thiết bị offline 95 ngày có pending Bookmark A. Web đã xóa Bookmark A ngày 5. Client kết nối lại. | Nhận `410 SYNC_REVISION_EXPIRED`; Safe Reconcile hủy bỏ stale UPSERT của Bookmark A; không phục sinh bookmark. |
| **SYNC-06** | Pull phân trang khi có mutation mới phát sinh | Client đang kéo delta trang 1 thì có thiết bị khác commit thêm revision mới. | Phân trang cursor-based hoạt động ổn định; không bị nhảy cóc (skip) hay sót delta; checkpoint an toàn. |
| **SYNC-07** | Crash giữa chừng khi apply local và lưu checkpoint | Client crash ngay sau khi ghi dữ liệu cục bộ nhưng chưa kịp lưu `lastRevision`. | Khởi động lại client tiếp tục pull từ `lastRevision` cũ; logic apply cục bộ idempotent không làm hỏng dữ liệu. |
| **SYNC-08** | Lệch bố cục phiên bản chương (Version Mismatch) | Hai thiết bị đọc hai `chapterVersionId` khác layout (vd: bản scan cũ vs bản remaster mới). | Không gộp `MAX(pageIndex)` sai vị trí đọc; bảo toàn vị trí đọc tương ứng với phiên bản chương. |
| **SYNC-09** | Guest Claim Commit từ Web, Mobile thực hiện sync | Người dùng claim tài khoản khách trên Web; Mobile mở app sau đó và pull sync. | Mobile kéo được toàn bộ delta do Guest Claim sinh ra; dữ liệu hòa trộn hoàn chỉnh. |
| **SYNC-10** | Client gửi revision vượt server hoặc hết hạn GC | Client gửi `baseServerRevision` lớn hơn server revision hiện tại hoặc nhỏ hơn `minActiveRevision`. | Fail-closed lập tức (`400 Bad Request` hoặc `410 Gone`); không cho phép dữ liệu vô căn cứ ghi vào hệ thống. |
| **SYNC-11** | Revision 64-bit vượt giới hạn safe integer của JS | Giả lập `revision = 9007199254740995` (`> 2^53 - 1`). | DTO dạng string giữ nguyên vẹn 100% giá trị số; không bị JavaScript làm tròn số (truncation error). |
| **SYNC-12** | Không kích hoạt Gamification khi Sync Replay | Thực hiện sync hàng loạt 100 chương lịch sử và tiến độ đọc. | Không phát thưởng điểm kinh nghiệm (EXP), OmniCoin, hay Streak ($\Delta = 0$). |

---

## 6. Phân Chia Thứ Tự Triển Khai Thống Nhất (Phase 7C Task Roadmap)

Nhằm đảm bảo sự nhất quán tuyệt đối giữa `ROADMAP.md`, `plans/phases/phase_07_product_completion.md` và tài liệu kiến trúc này, phạm vi các subtask của Phase 7C được thống nhất như sau:

* **Phase 7C.0: Architecture & Protocol Review Gate** `[/] ARCHITECTURE REVIEW`
  * Khóa 5 bất biến kỹ thuật, giải quyết triệt để các phát hiện P0/P1, ban hành hợp đồng mạng DTO và 12 kịch bản nghiệm thu.
* **Phase 7C.1: Database Schema & Core Entities (`services/api`)** `[ ] Chưa làm`
  * Tạo các bảng CSDL: `user_sync_state`, `sync_change_log`, `sync_tombstones`, `sync_mutation_receipts`.
  * TypeORM Entities kèm 64-bit Decimal String Transformer và SHA-256 payload hash helper.
* **Phase 7C.2: Core API Sync Hub & Delta Protocol (`services/api`)** `[ ] Chưa làm`
  * Cài đặt các endpoints: `GET /sync/changes`, `GET /sync/snapshot`, `POST /sync/mutations/batch`.
  * Bộ giải quyết xung đột (Domain Conflict Resolver) và bảo vệ Tombstone Anti-Resurrection.
  * Tích hợp `SyncLogEmitter` vào Guest Claim Commit và các API ghi thư viện hiện có.
* **Phase 7C.3: Web Client Sync Reconciler (`apps/web`)** `[ ] Chưa làm`
  * Nâng cấp IndexedDB Schema (thêm `sync_meta`, `quarantined_mutations`).
  * Điều phối đa tab qua `BroadcastChannel` bầu chọn Tab Leader thực hiện sync.
  * Cài đặt Safe 410 Full Resync Triage Reconciler.
* **Phase 7C.4: Mobile Client Sync Reconciler (`apps/mobile`)** `[ ] Chưa làm`
  * Nâng cấp SQLite Schema (bảng `pending_sync_mutations`, `sync_metadata`).
  * Cài đặt `SyncWorker` chạy nền với Exponential Backoff & Connectivity Gate.
  * Cài đặt Safe 410 Full Resync Triage Reconciler.
* **Phase 7C.5: Comprehensive Cross-Platform Sync Verification Matrix** `[ ] Chưa làm`
  * Kiểm thử toàn diện 12 kịch bản nghiệm thu `SYNC-01` đến `SYNC-12` trên cả Web, Mobile và Backend.
