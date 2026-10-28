# 🏛️ OmniNovel Architecture Gate: Phase 7C.0 — Unified Multi-Device Sync Engine
> **Document Status:** FINAL PROTOCOL CONSISTENCY AMENDMENT — ARCHITECTURE REVIEW GATE  
> **Milestone:** Phase 7C — Task 7C.0  
> **Review Outcome:** CONDITIONAL PASS (P0-A History Anti-Resurrection, P0-B Monotonic GC Watermark, P0-C Snapshot Consistency Protocol, P1 Canonical Mutation Hash, P1 Revision-Based Progress Resolution Fully Locked)  
> **Target Subsystems:** `services/api`, `packages/shared`, `apps/web`, `apps/mobile`  
> **Date:** 2026-10-28  
> **Author:** OmniNovel Engineering Core

---

## 1. Executive Summary & Design Philosophy

OmniNovel cung cấp nền tảng đọc truyện đa phương thức (Webtoon, Manga, Light Novel) liền mạch giữa Trình duyệt Web (Next.js) và Ứng dụng Di động (Flutter). Khi người dùng đọc trên nhiều thiết bị hoặc mở nhiều tab đồng thời, trạng thái thư viện (Bookmark, Tiến độ đọc từng trang/khối neo, Lịch sử chương, Cài đặt cá nhân) phải đạt tính **Eventually Consistent** tin cậy tuyệt đối, không thất thoát dữ liệu, và không bị sai lệch trong môi trường mạng chập chờn hoặc ngoại tuyến dài ngày.

```text
                  ┌─────────────────────────────────────────────────────────┐
                  │                 Core API (PostgreSQL SSoT)               │
                  │   user_sync_state (current_sync_rev, min_active_rev)    │
                  │   sync_change_log (Server Revisions 1..N)               │
                  │   sync_tombstones (Tombstone Horizon: 90 Days)          │
                  │   sync_mutation_receipts (Durable Idempotency Ledger)   │
                  │   reading_history_epoch_counters & tombstones (P7B)     │
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
         │   Snapshot Staging Store  │                   │   Snapshot Staging Store  │
         └───────────────────────────┘                   └───────────────────────────┘
```

---

## 2. Khóa 5 Bất Biến Cốt Lõi (5 Hardened Architectural Invariants)

| # | Trụ cột (Pillar) | Bất biến kỹ thuật & Quy tắc bắt buộc | Cơ chế bảo vệ & Chuẩn hóa (Hardening) |
|---|---|---|---|
| **P1** | **Monotonic Server Ordering & Wire Precision** | Server là trọng tài duy nhất cho trật tự thời gian logic. Mọi biến đổi được gán `revision BIGINT` tăng đơn điệu. Tuyệt đối **không tin tưởng đồng hồ client (Zero Wall-Clock Dependency)**. Trên đường truyền mạng, revision **phải được biểu diễn dạng Decimal String** (`string`) để bảo toàn độ chính xác 64-bit của JavaScript (`> 2^53 - 1`). Phân xử xung đột tiến độ giữa các phiên bản chương (`chapterVersionId`) dựa trên **Server Revision & Semantic Compatibility**, cấm dùng client timestamp. | Cột `BIGINT` trong PostgreSQL; cấp phát qua `FOR UPDATE` trên `user_sync_state`. TypeScript DTO sử dụng `string` cho mọi trường revision. So sánh quan hệ nhân quả qua `baseServerRevision` và `assignedRevision`. |
| **P2** | **Strict Idempotency with Durable Receipts** | Mọi mutation được định danh duy nhất bởi `(user_id, client_id, mutation_id)`. Mọi kết quả xử lý (bao gồm `APPLIED`, `DEDUPLICATED`, `REJECTED_TOMBSTONE`, `CONFLICT_MERGED`, `REJECTED_STALE`) phải được ghi nhận bền vững vào `sync_mutation_receipts` kèm **Full Mutation Canonical Hash** (SHA-256 bao phủ toàn bộ bộ thuộc tính bất biến: client, id, domain, entity, op, baseRev, payload). | Bảng riêng `sync_mutation_receipts` trong cùng transaction boundary. Retry cùng mutation trả lại đúng trạng thái ban đầu (`REJECTED_TOMBSTONE` trả lại lỗi từ chối, không đổi thành `DEDUPLICATED`); retry khác canonical hash trả HTTP `409 Conflict`. Race condition được giải quyết qua unique constraint. |
| **P3** | **Domain-Specific Convergence & Contract Parity** | Hòa trộn dữ liệu theo đúng ngữ nghĩa miền. Tái sử dụng hợp đồng Phase 7B: `ReadingMode` chuẩn là `'WEBTOON' \| 'PAGED' \| 'NOVEL'` (cấm dùng `MANGA_PAGED`). `PROGRESS` mang đầy đủ 7-tuple. Tiến độ đọc mang tính đơn điệu tăng (Monotonic Forward), cấm so sánh `pageIndex` mù quáng giữa hai `chapterVersionId` khác layout. | Tái sử dụng DTO từ Phase 7B. Rule: Version layout mismatch fallback an toàn; `forceRewind: true` mới được phép lùi chương. Lịch sử đọc gắn chặt với Phase 7B `reading_history_epoch_counters`. |
| **P4** | **Device Identity & Topology** | Tách bạch 3 định danh: `userId` (SSoT tài khoản) ↔ `sessionId` (`sid` JWT claim) ↔ `clientId` (UUIDv4 bản sao lưu trữ cục bộ). Đa tab Web phối hợp qua `BroadcastChannel` hoặc `navigator.locks` để bầu 1 Leader thực hiện sync, ngăn ngừa bão request. | Sinh `clientId` duy nhất 1 lần khi tạo cơ sở dữ liệu client. Cấm đồng nhất hóa `clientId` giữa các tab độc lập nếu không có leader gate. |
| **P5** | **Tombstones, Anti-Resurrection & Safe Full Resync** | Lệnh xóa sinh Tombstone có `revision`. Khi client nhận `410 SYNC_REVISION_EXPIRED` (offline quá hạn), **tuyệt đối KHÔNG tự động rebase pending mutations** sang revision mới. Cả `BOOKMARK` và `HISTORY` đều phải qua thuật toán Triage: mutation quá hạn cho thực thể không còn trong Cloud Snapshot bị hủy/cách ly (`quarantined_mutations`) để triệt tiêu nguy cơ phục sinh zombie data. Watermark `min_active_revision` luôn không-null, tăng đơn điệu. | Cửa sổ lưu giữ 90 ngày. Thuật toán Safe Reconcile xử lý 410. Khóa liên kết với `reading_history_tombstones`. Phân trang Snapshot có Isolation Boundary & Staging Store. |

---

## 3. Đặc Tả Chi Tiết Các Điểm Cải Tiến Bắt Buộc (Final Consistency Amendments)

### 3.1. [P0-A Fix] Khóa Lỗ Hổng Phục Sinh Lịch Sử Đọc (HISTORY Anti-Resurrection Protocol)

#### Phân tích lỗ hổng:
Trước đây, HISTORY được coi là *Commutative Append-only* và cho phép rebase thẳng về `snapshotRevision` sau `410 GONE`. Tuy nhiên, trong Phase 7B, người dùng có quyền xóa lịch sử đọc từng truyện hoặc toàn bộ thư viện (được bảo vệ bằng `reading_history_tombstones` và `reading_history_epoch_counters`). Nếu Mobile offline tại revision 100 với bản ghi đọc chương X, Web xóa lịch sử truyện đó ở revision 150, và sau 90 ngày tombstone hết hạn bị GC: việc Mobile tải snapshot và tự động rebase mutation đọc chương X sẽ làm **phục sinh lịch sử đọc đã bị xóa**.

#### Thuật Toán Triage Bắt Buộc Sau 410 GONE (Áp dụng cho Web & Mobile):
Khi client nhận `410 Gone / SYNC_REVISION_EXPIRED` (hoặc `client.lastRevision < server.minActiveRevision`):
1. **Phong tỏa hàng đợi:** Tạm dừng gửi `pending_mutations`.
2. **Kéo Snapshot nguyên vẹn:** Tải toàn bộ Cloud Snapshot qua endpoint `GET /api/v1/sync/snapshot` vào bộ đệm tạm thời (Snapshot Staging Store).
3. **Hoán đổi Replica Cục bộ:** Áp dụng Snapshot vào live replica trong một transaction cục bộ, cập nhật `lastRevision = snapshotRevision`.
4. **Phân loại từng Mutation Tồn đọng (Triage Matrix):**
   * **Miền `BOOKMARK` & `FOLLOW`:**
     * `UPSERT`: Nếu thực thể **KHÔNG CÓ trong Cloud Snapshot**: Vì `baseServerRevision < minActiveRevision`, không thể phân biệt được bookmark này mới tạo hay đã bị xóa trên Cloud và Tombstone đã bị GC. Do đó, **HỦY BỎ hoặc CÁCH LY** vào bảng `quarantined_mutations` với lý do `STALE_SNAPSHOT_DISCARDED`. **DELETE luôn thắng stale UPSERT.**
     * `UPSERT`: Nếu thực thể **ĐÃ CÓ trong Cloud Snapshot**: Đánh dấu đã hòa trộn (ACK), xóa khỏi pending.
     * `DELETE`: Nếu thực thể vẫn còn trong Cloud Snapshot, cập nhật `baseServerRevision = snapshotRevision` và đưa vào hàng đợi gửi lên. Nếu Cloud Snapshot cũng không còn, coi như đã hoàn thành (ACK).
   * **Miền `HISTORY` (`chapter_read_states`):**
     * **Bảo vệ chống phục sinh:** Đối chiếu `storyId` của mutation với Cloud Snapshot:
       * *Nếu truyện KHÔNG CÓ bất kỳ lịch sử đọc nào trong Cloud Snapshot:* Xác định truyện đã bị xóa lịch sử trong thời gian offline và Tombstone đã bị GC sau 90 ngày. **HỦY BỎ hoặc CÁCH LY** mutation vào `quarantined_mutations` với lý do `STALE_HISTORY_TOMBSTONE_DISCARDED`. Tuyệt đối không rebase để gửi lên Server!
       * *Nếu truyện ĐÃ CÓ trong Cloud Snapshot:* Kiểm tra xem chương này đã đọc chưa. Nếu chưa đọc hoặc tiến độ cao hơn, cập nhật `baseServerRevision = snapshotRevision` và re-queue gửi lên.
   * **Miền `PROGRESS`:**
     * Đối chiếu với `reading_progress` trong Cloud Snapshot:
       * Nếu `cloud.chapterIndex > pending.chapterIndex` và `forceRewind !== true`: **HỦY BỎ** tiến độ chương cũ, không đưa vào pending.
       * Nếu cùng chương và cùng `chapterVersionId`: Nếu `pending.progressPercentage > cloud.progressPercentage`, cập nhật `baseServerRevision = snapshotRevision`.
       * Nếu khác `chapterVersionId`: Giữ nguyên tiến độ Cloud; lưu trạng thái đọc cục bộ vào lịch sử.
   * **Miền `PREFERENCE`:**
     * Giữ nguyên nếu người dùng chủ động sửa đổi khi offline, cập nhật `baseServerRevision = snapshotRevision`.

---

### 3.2. [P0-B Fix] Thuật Toán GC Watermark Tăng Đơn Điệu, Không-Null & Bền Vững

#### Phân tích lỗ hổng:
Công thức `MIN(revision) FROM sync_change_log WHERE created_at >= Cutoff` sẽ trả về `NULL` nếu người dùng không có biến đổi nào trong 90 ngày qua. Nếu watermark trở thành `NULL`, server mất căn cứ xác định stale client. Ngoài ra, `min_active_revision` phải đại diện cho **cursor thấp nhất còn có thể replay**, chứ không được tạo khoảng trống biên (off-by-one).

#### Thuật Toán Garbage Collection Watermark Chuẩn Xác:
Thuật toán chạy định kỳ (Cronjob) và thực thi trong **một PostgreSQL Transaction nguyên tử duy nhất cho từng user**:

```text
-- Đầu vào: user_id, retention_window = '90 days'
CutoffTime = NOW() - INTERVAL '90 days'

-- Bước 1: Tìm revision thấp nhất còn nằm trong cửa sổ lưu trữ 90 ngày
CandidateMinRev = (
    SELECT MIN(revision) 
    FROM sync_change_log 
    WHERE user_id = $1 AND created_at >= CutoffTime
)

-- Bước 2: Tính toán TargetMinRevision (Bảo đảm không-null và tăng đơn điệu)
IF CandidateMinRev IS NOT NULL THEN
    -- Có mutations trong 90 ngày: watermark tiến lên revision nhỏ nhất này, không bao giờ thụt lùi
    TargetMinRevision = GREATEST(user_sync_state.min_active_revision, CandidateMinRev)
ELSE
    -- Toàn bộ change log cũ hơn 90 ngày hoặc không có mutation nào:
    -- Toàn bộ change log cũ sẽ bị dọn sạch. Mọi client cũ hơn head revision đều phải Full Resync.
    -- Watermark tiến thẳng lên current_sync_revision:
    TargetMinRevision = user_sync_state.current_sync_revision
END IF

-- Bước 3: Dọn dẹp dữ liệu cũ hơn watermark mới
DELETE FROM sync_tombstones 
WHERE user_id = $1 AND deleted_at_revision < TargetMinRevision;

DELETE FROM sync_change_log 
WHERE user_id = $1 AND revision < TargetMinRevision;

-- Bước 4: Cập nhật watermark bền vững
UPDATE user_sync_state 
SET min_active_revision = TargetMinRevision,
    last_synced_at = NOW()
WHERE user_id = $1;
```

#### Quy Tắc Phân Xử Biên Cho Pull và Push (Replay Horizon Rules):
* **Pull Guard (`GET /sync/changes?after=:after`):**
  * Nếu `BigInt(after) < BigInt(user_sync_state.min_active_revision)`:
    ➔ **Fail-Closed lập tức:** Trả về HTTP `410 Gone` (`SYNC_REVISION_EXPIRED`, kèm `minActiveRevision`, `currentServerRevision`).
  * Nếu `BigInt(after) >= BigInt(user_sync_state.min_active_revision)`:
    ➔ Hợp lệ. Server trả về delta các bản ghi có `revision > after` tăng dần.
* **Push Guard (`POST /sync/mutations/batch`):**
  * Nếu bất kỳ mutation nào có `BigInt(mutation.baseServerRevision) < BigInt(user_sync_state.min_active_revision)`:
    ➔ Server từ chối mutation đó với `status: 'REJECTED_STALE'`, ghi receipt vào `sync_mutation_receipts`, không cấp revision. Nếu toàn bộ batch đều stale, trả về HTTP `410 Gone`.

---

### 3.3. [P0-C Fix] Giao Thức Phân Trang Snapshot Nhất Quán (Snapshot Consistency Protocol)

#### Phân tích lỗ hổng:
Nếu người dùng có thư viện lớn (hàng nghìn chương và bookmark), `GET /api/v1/sync/snapshot` cần phân trang. Nếu trong lúc client đang kéo giữa Trang 1 và Trang 2 mà có thiết bị khác thực hiện xóa/thêm, client sẽ nhận một snapshot bị pha trộn (torn snapshot).

#### Cơ Chế Ghim Revision (Snapshot Revision Pinning) & Staging Store:
1. **Khởi tạo Snapshot (Trang 1):**
   * Client gọi `GET /api/v1/sync/snapshot?limit=200` (không gửi `revision` hoặc gửi `cursor=null`).
   * Server ghim `snapshotRevision = user_sync_state.current_sync_revision`.
   * Server truy vấn dữ liệu dưới mức cô lập transaction hoặc bộ lọc nhất quán: chỉ trả về các bản ghi tồn tại tại `snapshotRevision` (loại bỏ các bản ghi tạo sau `snapshotRevision` hoặc bị tombstone xóa trước/bằng `snapshotRevision`).
   * Server sinh opaque signed cursor: `nextCursor = base64url(sign({ snapshotRevision, domain, offsetId }))`.
2. **Kéo Các Trang Tiếp Theo:**
   * Client gửi `GET /api/v1/sync/snapshot?cursor=:nextCursor`.
   * Server giải mã cursor, xác minh tính toàn vẹn chữ ký và kiểm tra `snapshotRevision`.
   * **Bảo vệ hủy hợp lệ (Snapshot Invalidation Guard):** Nếu server phát hiện `snapshotRevision < user_sync_state.min_active_revision` (bị GC dọn dẹp trong lúc đang phân trang, dù cực kỳ hy hữu), server lập tức trả về HTTP `409 Conflict` (`SNAPSHOT_INVALIDATED`), buộc client bắt đầu lại Trang 1.
3. **Cơ Chế Khách Cục Bộ: Snapshot Staging Store:**
   * Client Web và Mobile tạo một bảng tạm: `snapshot_staging_store`.
   * Các trang dữ liệu kéo về được ghi vào `snapshot_staging_store`, **tuyệt đối không ghi đè trực tiếp lên live replica**.
   * Chỉ khi nhận được trang cuối cùng (`hasMore === false`):
     * Mở một Local Database Transaction nguyên tử:
       1. Trút toàn bộ dữ liệu từ `snapshot_staging_store` vào live replica.
       2. Cập nhật `lastRevision = snapshotRevision`.
       3. Thực thi thuật toán Triage (Mục 3.1) cho các pending mutations.
       4. Xóa sạch `snapshot_staging_store`.
     * Nếu client gặp sự cố mạng hoặc crash giữa chừng, `snapshot_staging_store` bị hủy bỏ; live replica và hàng đợi pending cũ được giữ nguyên vẹn 100%.

---

### 3.4. [P1 Refinement] Full Mutation Canonical Hash & Phân Xử Retry Idempotency Độc Lập

#### 1. Full Mutation Canonical Hash (SHA-256):
Để tránh tình trạng hai mutation có payload giống hệt nhau nhưng khác `domain`, `entityId`, `operation` hoặc `baseServerRevision` bị nhận diện nhầm là cùng một mutation, hàm hash phải bao phủ toàn bộ nội dung bất biến:

```typescript
import { createHash } from 'crypto';

export function computeCanonicalMutationHash(mutation: ClientMutationDto): string {
  // Sắp xếp các key theo thứ tự chữ cái chuẩn mực (canonical JSON)
  const canonicalObject = {
    baseServerRevision: String(mutation.baseServerRevision),
    clientId: mutation.clientId,
    domain: mutation.domain,
    entityId: mutation.entityId,
    mutationId: mutation.mutationId,
    operation: mutation.operation,
    payload: mutation.payload, // Recursive sorted keys
  };
  
  return createHash('sha256')
    .update(JSON.stringify(canonicalObject, Object.keys(canonicalObject).sort()))
    .digest('hex');
}
```
*(Chỉ trường chẩn đoán phi trọng tài `clientCreatedAt` được loại khỏi hash).*

#### 2. Phân Xử Trạng Thái Retry Ổn Định:
Khi nhận một mutation có `(user_id, client_id, mutation_id)` đã tồn tại trong `sync_mutation_receipts`:
* So sánh `current_hash === receipt.payload_hash`:
  * Nếu **KHÁC HASH**: Trả về lỗi HTTP `409 Conflict` (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`).
  * Nếu **TRÙNG HASH**: Trả lại đúng trạng thái ban đầu của biên nhận:
    * Nếu gốc là `APPLIED`: Trả về `status: 'DEDUPLICATED'`, `assignedRevision: receipt.assigned_revision`.
    * Nếu gốc là `REJECTED_TOMBSTONE`: Trả về `status: 'REJECTED_TOMBSTONE'`, `assignedRevision: null`, `message: receipt.response_meta.message`.
    * Nếu gốc là `REJECTED_STALE`: Trả về `status: 'REJECTED_STALE'`, `assignedRevision: null`.
    * Nếu gốc là `CONFLICT_MERGED`: Trả về `status: 'CONFLICT_MERGED'`, `assignedRevision: receipt.assigned_revision`.
  * **Quy tắc quan trọng:** Tuyệt đối không biến mutation bị `REJECTED` thành `DEDUPLICATED` trên phản hồi, giúp client không bị ngộ nhận thao tác thất bại là thành công.

#### 3. Xử Lý Yêu Cầu Đồng Thời (Concurrent Key Collisions):
Khi hai request cùng `(user_id, client_id, mutation_id)` bay tới đồng thời:
* Nhờ khóa chính `PRIMARY KEY (user_id, client_id, mutation_id)` trên `sync_mutation_receipts`, giao dịch thứ hai sẽ chờ khóa hàng (row-level lock) của giao dịch thứ nhất hoặc nhận lỗi conflict.
* Khi giao dịch thứ nhất commit, giao dịch thứ hai đọc biên nhận đã lưu và trả về kết quả tương ứng an toàn, không bao giờ chạy side-effects hai lần.

---

### 3.5. [P1 Refinement] Phân Xử Xung Đột Tiến Độ Không Dùng Timestamp (Revision-Based Progress Resolution)

Loại bỏ hoàn toàn việc so sánh timestamp client. Quy tắc phân xử giữa các phiên bản chương (`chapterVersionId`) tuân thủ nghiêm ngặt:

1. **Khác Chương (Cross-Chapter):**
   * Chương có số thứ tự / vị trí lớn hơn trong truyện luôn thắng (Monotonic Forward Progress).
   * Lùi về chương cũ chỉ được chấp thuận khi có cờ tường minh: `forceRewind: true`.
2. **Cùng Chương, Cùng `chapterVersionId`:**
   * So sánh số học: Giá trị `progressPercentage` lớn hơn thắng; `pageIndex` lớn hơn thắng.
3. **Cùng Chương, Khác `chapterVersionId` (Layout Không Tương Thích):**
   * Không so sánh `pageIndex` mù quáng giữa hai bản scan/layout khác nhau.
   * **Phân xử theo quan hệ nhân quả (Server Revision Causality):**
     * Nếu `BigInt(incoming.baseServerRevision) >= BigInt(cloudProgress.assignedRevision)`:
       ➔ Mutation của client được sinh ra sau khi client đã quan sát trạng thái của Cloud (hoặc người dùng chủ động đổi phiên bản đọc trên thiết bị). Cloud **chấp thuận phiên bản mới của client**.
     * Nếu `BigInt(incoming.baseServerRevision) < BigInt(cloudProgress.assignedRevision)`:
       ➔ Đây là phiên đọc ngoại tuyến đồng thời trên bản dịch cũ mà không biết trên Cloud đã đổi phiên bản. Cloud **giữ nguyên tiến độ của phiên bản Cloud hiện tại**, đồng thời ghi nhận sự kiện đọc bản cũ vào `chapter_read_states` (lịch sử đọc) để không mất dữ liệu.
   * Bản sao cục bộ lưu trữ tuple đọc riêng theo `(storyId, chapterVersionId)` để reader không bị nhảy layout khi mở lại.

---

## 4. Đặc Tả Cơ Sở Dữ Liệu PostgreSQL Chuẩn Hóa

```sql
-- 1. Bảng Quản lý Trạng thái Revision và GC Watermark của User
CREATE TABLE IF NOT EXISTS user_sync_state (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    current_sync_revision BIGINT NOT NULL DEFAULT 0,
    min_active_revision BIGINT NOT NULL DEFAULT 0,
    last_synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_sync_revision_monotonic CHECK (min_active_revision <= current_sync_revision)
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

CREATE INDEX IF NOT EXISTS idx_sync_change_log_gc 
    ON sync_change_log(user_id, created_at ASC);

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
    payload_hash VARCHAR(64) NOT NULL, -- SHA-256 Full Mutation Canonical Hash
    status VARCHAR(32) NOT NULL,        -- 'APPLIED' | 'DEDUPLICATED' | 'REJECTED_TOMBSTONE' | 'CONFLICT_MERGED' | 'REJECTED_STALE'
    assigned_revision BIGINT,           -- NULL nếu bị từ chối
    response_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, client_id, mutation_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_mutation_receipts_lookup 
    ON sync_mutation_receipts(user_id, client_id, mutation_id);
```

---

## 5. Đặc Tả Hợp Đồng Mạng & DTOs (TypeScript Contracts)

### 5.1. DTO Mutation Đẩy Lên (`POST /api/v1/sync/mutations/batch`)

```typescript
export enum ReadingMode {
  WEBTOON = 'WEBTOON',
  PAGED = 'PAGED',
  NOVEL = 'NOVEL',
}

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

export interface ClientMutationDto {
  clientId: string;           // UUIDv4
  mutationId: string;         // UUIDv4
  domain: 'BOOKMARK' | 'PROGRESS' | 'HISTORY' | 'PREFERENCE' | 'FOLLOW';
  entityId: string;           // StoryId hoặc StoryId:ChapterId
  operation: 'UPSERT' | 'DELETE';
  baseServerRevision: string; // 64-bit Decimal String
  payload: Record<string, any>;
  clientCreatedAt: string;    // ISO-8601 Telemetry only
}

export interface PushMutationsBatchDto {
  mutations: ClientMutationDto[];
}

export type MutationExecutionStatus = 
  | 'APPLIED'
  | 'DEDUPLICATED'
  | 'REJECTED_TOMBSTONE'
  | 'CONFLICT_MERGED'
  | 'REJECTED_STALE';

export interface MutationResultItem {
  mutationId: string;
  status: MutationExecutionStatus;
  assignedRevision: string | null;
  message?: string;
}

export interface PushMutationsBatchResponseDto {
  processedCount: number;
  newServerRevision: string;
  results: MutationResultItem[];
}
```

### 5.2. DTO Kéo Delta (`GET /api/v1/sync/changes`)

```typescript
export interface SyncChangeItemDto {
  revision: string; // Decimal string
  domain: 'BOOKMARK' | 'PROGRESS' | 'HISTORY' | 'PREFERENCE' | 'FOLLOW';
  entityId: string;
  operation: 'UPSERT' | 'DELETE';
  payload: Record<string, any>;
  createdAt: string;
}

export interface SyncChangesResponseDto {
  currentServerRevision: string; // Decimal string
  minActiveRevision: string;     // Decimal string
  nextRevision: string | null;   // Cursor cho trang kế tiếp, null nếu caught up
  hasMore: boolean;
  changes: SyncChangeItemDto[];
}
```

### 5.3. DTO Kéo Snapshot Nhất Quán (`GET /api/v1/sync/snapshot`)

```typescript
export interface SyncSnapshotResponseDto {
  snapshotRevision: string;      // Decimal string ghim cố định
  minActiveRevision: string;     // Decimal string
  hasMore: boolean;
  nextCursor: string | null;     // Signed opaque token ghim snapshotRevision
  data: {
    bookmarks: Array<{ storyId: string; createdAt: string }>;
    readingProgress: Array<ProgressMutationPayload>;
    chapterReadStates: Array<{ 
      chapterId: string; 
      storyId: string;
      chapterVersionId?: string | null;
      maxProgressPercentage: number; 
      completedAt: string | null; 
      lastReadAt: string 
    }>;
    preferences: Array<{ key: string; value: any; updatedAt: string }>;
  };
}
```

---

## 6. Ma Trận Nghiệm Thu Bắt Buộc (18 Acceptance Scenarios)

| Scenario ID | Tình huống kiểm thử | Hành động & Điều kiện | Kỳ vọng nghiệm thu (Expected Invariant) |
|---|---|---|---|
| **SYNC-01** | Hai thiết bị gửi mutation đồng thời | Web & Mobile cùng gửi batch mutation lên Server tại cùng một thời điểm. | Không race condition; PostgreSQL cấp revision tăng đơn điệu không trùng lặp; thứ tự commit hợp lệ. |
| **SYNC-02** | Retry mutation đã `APPLIED` | Client gửi lại mutation đã được xử lý thành công trước đó (cùng ID, cùng canonical hash). | Nhận trạng thái `DEDUPLICATED` kèm assigned revision gốc; không sinh side-effects hay tăng revision. |
| **SYNC-03** | Retry mutation đã bị `REJECTED` | Client gửi lại mutation trước đó đã bị `REJECTED_TOMBSTONE` hoặc `REJECTED_STALE`. | Nhận đúng kết quả từ chối ban đầu từ `sync_mutation_receipts`; **không bị biến thành DEDUPLICATED**. |
| **SYNC-04** | Tái sử dụng Mutation ID với Payload khác | Client gửi mutation ID cũ nhưng sửa đổi payload. | Trả lỗi HTTP `409 Conflict` (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`); chặn đứng hành vi giả mạo ID. |
| **SYNC-05** | Offline > 90 ngày với pending UPSERT cũ | Thiết bị offline 95 ngày có pending Bookmark A. Web đã xóa Bookmark A ngày 5. Client kết nối lại. | Nhận `410 SYNC_REVISION_EXPIRED`; Safe Reconcile hủy bỏ stale UPSERT của Bookmark A; **không phục sinh bookmark**. |
| **SYNC-06** | Pull phân trang khi có mutation mới phát sinh | Client đang kéo delta trang 1 thì có thiết bị khác commit thêm revision mới. | Phân trang cursor-based hoạt động ổn định; không bị nhảy cóc (skip) hay sót delta; checkpoint an toàn. |
| **SYNC-07** | Crash giữa chừng khi apply local và lưu checkpoint | Client crash ngay sau khi ghi dữ liệu cục bộ nhưng chưa kịp lưu `lastRevision`. | Khởi động lại client tiếp tục pull từ `lastRevision` cũ; logic apply cục bộ idempotent không làm hỏng dữ liệu. |
| **SYNC-08** | Lệch bố cục phiên bản chương (Version Mismatch) | Hai thiết bị đọc hai `chapterVersionId` khác layout (vd: bản scan cũ vs bản remaster mới). | Không gộp `MAX(pageIndex)` sai vị trí đọc; bảo toàn vị trí đọc tương ứng với phiên bản chương. |
| **SYNC-09** | Guest Claim Commit từ Web, Mobile thực hiện sync | Người dùng claim tài khoản khách trên Web; Mobile mở app sau đó và pull sync. | Mobile kéo được toàn bộ delta do Guest Claim sinh ra qua `SyncLogEmitter`; dữ liệu hòa trộn hoàn chỉnh. |
| **SYNC-10** | Client gửi revision vượt server hoặc hết hạn GC | Client gửi `baseServerRevision` lớn hơn server revision hiện tại hoặc nhỏ hơn `minActiveRevision`. | Fail-closed lập tức (`400 Bad Request` hoặc `410 Gone`); không cho phép dữ liệu vô căn cứ ghi vào hệ thống. |
| **SYNC-11** | Revision 64-bit vượt giới hạn safe integer của JS | Giả lập `revision = 9007199254740995` (`> 2^53 - 1`). | DTO dạng decimal string giữ nguyên vẹn 100% giá trị số; không bị JavaScript làm tròn số (truncation error). |
| **SYNC-12** | Không kích hoạt Gamification khi Sync Replay | Thực hiện sync hàng loạt 100 chương lịch sử và tiến độ đọc. | Không phát thưởng điểm kinh nghiệm (EXP), OmniCoin, hay Streak ($\Delta = 0$). |
| **SYNC-13** | History cũ sau khi Web xóa và tombstone GC | Mobile offline giữ pending history chương X. Web xóa lịch sử truyện. Quá 90 ngày GC dọn tombstone. Mobile kết nối lại. | Nhận `410 Gone`; Triage đối chiếu thấy truyện không còn trong Snapshot ➔ **Hủy bỏ stale history; không phục sinh lịch sử đọc đã xóa**. |
| **SYNC-14** | Change log trống sau GC vẫn giữ watermark hợp lệ | Người dùng không có thao tác nào trong 95 ngày. Cronjob GC chạy. | Watermark `min_active_revision` tiến lên `current_sync_revision`, **không bị NULL**; client cũ kết nối nhận đúng `410 Gone`. |
| **SYNC-15** | Mutation đến giữa hai trang snapshot | Client kéo Trang 1 snapshot. Thiết bị khác xóa bookmark. Client kéo tiếp Trang 2. | Nhờ ghim `snapshotRevision` và Snapshot Staging Store, client nhận được trạng thái logic nhất quán, không bị torn snapshot. |
| **SYNC-16** | Cùng mutation ID, payload giống nhưng domain/op khác | Client gửi mutation ID cũ với payload giống nhưng đổi từ `BOOKMARK` sang `PROGRESS` hoặc `UPSERT` sang `DELETE`. | Canonical hash kiểm tra toàn diện phát hiện sai lệch thuộc tính ➔ Chặn đứng với HTTP `409 Conflict`. |
| **SYNC-17** | Retry rejected mutation trả đúng kết quả từ chối | Client retry mutation bị `REJECTED_TOMBSTONE`. | Server tra cứu `sync_mutation_receipts` và trả về `status: 'REJECTED_TOMBSTONE'`, không biến thành `DEDUPLICATED`. |
| **SYNC-18** | Hai request cùng idempotency key bay tới đồng thời | Hai request cùng key đến trong cùng một mili-giây. | Transaction row lock / unique constraint xử lý nguyên tử: 1 request ghi receipt, request thứ hai đọc receipt; chỉ tạo 1 kết quả duy nhất. |

---

## 7. Phân Chia Thứ Tự Triển Khai Thống Nhất (Phase 7C Task Roadmap)

* **Phase 7C.0: Architecture & Protocol Review Gate** `[/] ARCHITECTURE REVIEW`
  * Khóa 5 bất biến kỹ thuật, giải quyết triệt để các phát hiện P0/P1, ban hành hợp đồng mạng DTO và 18 kịch bản nghiệm thu.
* **Phase 7C.1: Database Schema & Core Entities (`services/api`)** `[ ] Chưa làm`
  * Tạo các bảng CSDL: `user_sync_state`, `sync_change_log`, `sync_tombstones`, `sync_mutation_receipts`.
  * TypeORM Entities kèm 64-bit Decimal String Transformer và Full Mutation SHA-256 canonical hash helper.
* **Phase 7C.2: Core API Sync Hub & Delta Protocol (`services/api`)** `[ ] Chưa làm`
  * Cài đặt các endpoints: `GET /sync/changes`, `GET /sync/snapshot` (kèm Cursor Pinning), `POST /sync/mutations/batch`.
  * Bộ giải quyết xung đột (Domain Conflict Resolver) và bảo vệ Tombstone Anti-Resurrection (Bookmark & History).
  * Tích hợp `SyncLogEmitter` vào Guest Claim Commit và các API ghi thư viện hiện có.
* **Phase 7C.3: Web Client Sync Reconciler (`apps/web`)** `[ ] Chưa làm`
  * Nâng cấp IndexedDB Schema (thêm `sync_meta`, `quarantined_mutations`, `snapshot_staging_store`).
  * Điều phối đa tab qua `BroadcastChannel` bầu chọn Tab Leader thực hiện sync.
  * Cài đặt Safe 410 Full Resync Triage Reconciler (chống phục sinh bookmark & history).
* **Phase 7C.4: Mobile Client Sync Reconciler (`apps/mobile`)** `[ ] Chưa làm`
  * Nâng cấp SQLite Schema (bảng `pending_sync_mutations`, `sync_metadata`, `snapshot_staging`).
  * Cài đặt `SyncWorker` chạy nền với Exponential Backoff & Connectivity Gate.
  * Cài đặt Safe 410 Full Resync Triage Reconciler (chống phục sinh bookmark & history).
* **Phase 7C.5: Comprehensive Cross-Platform Sync Verification Matrix** `[ ] Chưa làm`
  * Kiểm thử tự động toàn diện 18 kịch bản nghiệm thu `SYNC-01` đến `SYNC-18` trên cả Web, Mobile và Backend.
