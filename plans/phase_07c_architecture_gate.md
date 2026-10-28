# 🏛️ OmniNovel Architecture Gate: Phase 7C.0 — Unified Multi-Device Sync Engine
> **Document Status:** ARCHITECTURAL SPECIFICATION & REVIEW GATE ACCEPTED — CLOSED / PASS  
> **Milestone:** Phase 7C — Task 7C.0  
> **Review Outcome:** ARCHITECTURE GATE OFFICIALLY ACCEPTED & CLOSED (Effective History Epoch Locked, Repeatable Read Snapshot Isolation Enforced, JCS RFC 8785 & I-JSON Strict Fail-Closed Input Validation Standardized)  
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
| **P2** | **Strict Idempotency with Durable Receipts** | Mọi mutation được định danh duy nhất bởi `(user_id, client_id, mutation_id)`. Mọi kết quả xử lý (bao gồm `APPLIED`, `DEDUPLICATED`, `REJECTED_TOMBSTONE`, `CONFLICT_MERGED`, `REJECTED_STALE`) phải được ghi nhận bền vững vào `sync_mutation_receipts` kèm **Full Mutation Canonical Hash** (SHA-256 tính trên serializer đệ quy chuẩn JCS RFC 8785 kèm I-JSON strict domain validation, cấm dùng array replacer). Biên nhận là bất biến: client không thể tái sử dụng `mutationId` với `baseServerRevision` mới. | Bảng riêng `sync_mutation_receipts` trong cùng transaction boundary. Serializer đệ quy bảo toàn toàn bộ nested keys; fail-closed khi gặp NaN, Infinity, native BigInt. Retry cùng mutation trả lại đúng trạng thái ban đầu (`REJECTED_TOMBSTONE` giữ nguyên mã từ chối, không đổi thành `DEDUPLICATED`); retry khác canonical hash trả HTTP `409 Conflict`. |
| **P3** | **Domain-Specific Convergence & Contract Parity** | Hòa trộn dữ liệu theo đúng ngữ nghĩa miền. Tái sử dụng hợp đồng Phase 7B: `ReadingMode` chuẩn là `'WEBTOON' \| 'PAGED' \| 'NOVEL'` (cấm dùng `MANGA_PAGED`). `PROGRESS` mang đầy đủ 7-tuple. Tiến độ đọc mang tính đơn điệu tăng (Monotonic Forward), cấm so sánh `pageIndex` mù quáng giữa hai `chapterVersionId` khác layout. Lịch sử đọc được bảo vệ chặt chẽ bởi **`observedHistoryEpoch`** (bắt buộc) tuân thủ quy tắc **Strict Equality với `effectiveEpoch = MAX(storyTombstoneEpoch ?? 0, globalSentinelEpoch ?? 0)`** của Phase 7B. | Tái sử dụng DTO từ Phase 7B. Rule: Version layout mismatch fallback an toàn; `forceRewind: true` mới được phép lùi chương. Lịch sử đọc mang epoch lệch với effective epoch bị từ chối triệt để, không phục sinh. |
| **P4** | **Device Identity & Topology** | Tách bạch 3 định danh: `userId` (SSoT tài khoản) ↔ `sessionId` (`sid` JWT claim) ↔ `clientId` (UUIDv4 bản sao lưu trữ cục bộ). Đa tab Web phối hợp qua `BroadcastChannel` hoặc `navigator.locks` để bầu 1 Leader thực hiện sync, ngăn ngừa bão request. | Sinh `clientId` duy nhất 1 lần khi tạo cơ sở dữ liệu client. Cấm đồng nhất hóa `clientId` giữa các tab độc lập nếu không có leader gate. |
| **P5** | **Tombstones, Anti-Resurrection & Safe Full Resync** | Lệnh xóa sinh Tombstone có `revision`. Khi client nhận `410 SYNC_REVISION_EXPIRED` (offline quá hạn), **tuyệt đối KHÔNG tự động rebase pending mutations** sang revision mới. Phân trang Snapshot được thực thi độc quyền trong transaction **`REPEATABLE READ READ ONLY`** kết hợp chiến lược **Optimistic Snapshot Restart (409 SNAPSHOT_INVALIDATED)** và **Snapshot Staging Store** cục bộ để loại bỏ hoàn toàn nguy cơ Torn Read. Watermark `min_active_revision` luôn không-null, tăng đơn điệu. | Cửa sổ lưu giữ 90 ngày. Thuật toán Safe Reconcile xử lý 410. Khóa liên kết với `reading_history_tombstones`. Mức cô lập REPEATABLE READ READ ONLY trên từng trang snapshot. |

---

## 3. Đặc Tả Chi Tiết Các Điểm Cải Tiến Cốt Lõi (Final Technical Refinements)

### 3.1. [P0 Fix] Thuật Toán Serializer Canonical JSON Đệ Quy Chuẩn Mực & Giới Hạn Đầu Vào (JCS RFC 8785 & RFC 7493 I-JSON)

#### Phân tích lỗi thực thi trước đây & Các rủi ro Fail-Closed:
1. **Lọc bỏ thuộc tính lồng nhau (Key Stripping):** Khi truyền `replacer` là một mảng `Object.keys(...)` vào `JSON.stringify`, JavaScript coi đó là whitelist cấp 1 và lọc bỏ toàn bộ các key lồng nhau bên trong `payload`. Do đó, hai payload khác nhau như `{ chapterId: 'X', progressPercentage: 70 }` và `{ chapterId: 'Y', progressPercentage: 95 }` đều bị biến thành `"payload": {}`, sinh ra cùng SHA-256 hash và phá vỡ hoàn toàn tính khả trùng P2!
2. **Bỏ qua thuộc tính `undefined` (Undetected Undefined):** Nếu hàm kiểm tra cho qua `undefined`, serializer tiêu chuẩn sẽ âm thầm bỏ qua key đó, khiến `{ x: 70 }` và `{ x: 70, y: undefined }` sinh ra cùng canonical output `{"x":70}`, tạo lỗ hổng va chạm hash.
3. **Đối tượng không thuộc chuẩn JSON (Date, Map, Set, Class instances):** `new Date(...)` bị `JSON.stringify` chuyển thành chuỗi ISO hoặc `{}` tùy ngữ cảnh đối tượng; `Map`/`Set` bị chuyển thành `{}` rỗng, có thể trùng hash với object rỗng thực tế `{}`.
4. **Mảng thưa (Sparse Arrays):** Mảng có lỗ hổng như `[1, , 3]` hoặc `new Array(3)` có thể sinh JSON không hợp lệ hoặc sai lệch chỉ mục.
5. **Surrogate pairs cô lập (Lone Surrogates):** Chuỗi chứa surrogate UTF-16 lẻ đứng đơn độc (cả trên key lẫn value) vi phạm chuẩn I-JSON và có thể bị Unicode serializer làm hỏng hoặc phân mảnh.
6. **Âm thầm thay thế payload bị thiếu:** Dùng fallback `mutation.payload ?? {}` sẽ biến payload bị thiếu/undefined thành `{}` rỗng, che giấu lỗi client thay vì fail-closed.

#### Thuật Toán Serializer Đệ Quy Chuẩn Mực Kèm Kiểm Tra Miền Dữ Liệu I-JSON:
Hệ thống sử dụng hàm serialize đệ quy độc lập, sắp xếp khóa theo thứ tự từ điển UTF-16 ở mọi cấp độ đối tượng lồng nhau, tuân thủ tiêu chuẩn RFC 8785 (JSON Canonicalization Scheme) và fail-closed lập tức nếu gặp giá trị ngoài miền I-JSON hợp lệ:

```typescript
import { createHash } from 'crypto';

/**
 * Kiểm tra xem chuỗi có chứa lone surrogate (surrogate pair bị cô lập) hay không.
 * Quét toàn bộ UTF-16 code units: code trong dải [0xD800, 0xDBFF] (High surrogate)
 * bắt buộc phải đi liền với [0xDC00, 0xDFFF] (Low surrogate).
 */
function hasLoneSurrogate(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= str.length) return true;
      const next = str.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++; // Bỏ qua low surrogate đã ghép cặp hợp lệ
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // Low surrogate đứng đơn lẻ
    }
  }
  return false;
}

/**
 * Kiểm tra tính hợp lệ của dữ liệu theo chuẩn RFC 8785 (JCS) và RFC 7493 (I-JSON).
 * Fail-closed triệt để trước khi hashing: từ chối undefined, lone surrogates,
 * Date, Map, Set, class instances, cyclic references, sparse arrays, NaN, Infinity, native bigint.
 */
function validateIJsonDomain(value: unknown, path = 'root', seen = new WeakSet()): void {
  if (value === undefined) {
    throw new Error(`[JCS] 'undefined' is not valid JSON data at ${path}`);
  }
  
  if (value === null || typeof value === 'boolean') {
    return;
  }
  
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`[JCS] Invalid non-finite number at ${path}: ${value}`);
    }
    return;
  }
  
  if (typeof value === 'bigint') {
    throw new Error(`[JCS] Native bigint not allowed at ${path}; must be serialized as decimal string`);
  }
  
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) {
      throw new Error(`[JCS] Invalid lone surrogate in UTF-16 string at ${path}`);
    }
    return;
  }
  
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`[JCS] Unsupported data type ${typeof value} at ${path}`);
  }
  
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error(`[JCS] Cyclic reference detected at ${path}`);
    }
    seen.add(value);
    for (let i = 0; i < value.length; i++) {
      if (!(i in value) || value[i] === undefined) {
        throw new Error(`[JCS] Sparse array or undefined element not allowed at ${path}[${i}]`);
      }
      validateIJsonDomain(value[i], `${path}[${i}]`, seen);
    }
    return;
  }
  
  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error(`[JCS] Cyclic reference detected at ${path}`);
    }
    // Chỉ chấp nhận plain JSON objects (từ chối Date, Map, Set, RegExp, custom classes)
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const typeName = Object.prototype.toString.call(value).slice(8, -1);
      throw new Error(`[JCS] Unsupported object type '${typeName}' at ${path}; only plain JSON objects are allowed`);
    }
    seen.add(value);
    
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    for (const key of keys) {
      // Kiểm tra lone surrogate trên object key
      if (hasLoneSurrogate(key)) {
        throw new Error(`[JCS] Invalid lone surrogate in object key at ${path}."${key}"`);
      }
      const propVal = obj[key];
      if (propVal === undefined) {
        throw new Error(`[JCS] Undefined property value not allowed at ${path}.${key}`);
      }
      validateIJsonDomain(propVal, `${path}.${key}`, seen);
    }
    return;
  }
  
  throw new Error(`[JCS] Unsupported data type at ${path}`);
}

/**
 * Serializer chuẩn JCS (RFC 8785):
 * Sắp xếp toàn bộ keys theo thứ tự từ điển UTF-16 đệ quy,
 * chuẩn hóa số âm 0 (-0 -> 0), bảo toàn 100% các thuộc tính con bên trong nested objects và arrays.
 */
export function canonicalJsonStringify(value: unknown): string {
  validateIJsonDomain(value);

  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && Object.is(value, -0)) {
      return '0';
    }
    return JSON.stringify(value);
  }
  
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJsonStringify(item)).join(',') + ']';
  }
  
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries: string[] = [];
  
  for (const key of sortedKeys) {
    entries.push(JSON.stringify(key) + ':' + canonicalJsonStringify(obj[key]));
  }
  
  return '{' + entries.join(',') + '}';
}

/**
 * Tính toán Full Mutation Canonical Hash bao phủ toàn bộ nội dung bất biến.
 * Payload bắt buộc phải là một đối tượng JSON hợp lệ (không chấp nhận thiếu hoặc rỗng ngầm định).
 */
export function computeCanonicalMutationHash(mutation: ClientMutationDto): string {
  if (
    !mutation.payload ||
    typeof mutation.payload !== 'object' ||
    Array.isArray(mutation.payload) ||
    (Object.getPrototypeOf(mutation.payload) !== Object.prototype && Object.getPrototypeOf(mutation.payload) !== null)
  ) {
    throw new Error(
      `[JCS] Mutation payload must be a valid non-null plain JSON object; received ${
        mutation.payload === null ? 'null' : typeof mutation.payload
      }`,
    );
  }

  const canonicalObject = {
    baseServerRevision: String(mutation.baseServerRevision),
    clientId: mutation.clientId,
    domain: mutation.domain,
    entityId: mutation.entityId,
    mutationId: mutation.mutationId,
    operation: mutation.operation,
    payload: mutation.payload,
  };
  
  return createHash('sha256')
    .update(canonicalJsonStringify(canonicalObject))
    .digest('hex');
}
```

#### Bộ Kiểm Thử JCS Conformance & Strict Domain Validation Suite:
1. **Xác Định Trật Tự Khóa (RFC 8785 UTF-16 Code Unit Order):**
   * Object với keys bất kỳ: `{ b: 2, a: 1, c: { z: 26, y: 25 } }` ➔ serialize thành duy nhất: `{"a":1,"b":2,"c":{"y":25,"z":26}}`.
   * So sánh thứ tự chuỗi UTF-16 code units (đúng chuẩn JavaScript `Array.prototype.sort()`).
2. **Khác Biệt Nested Payload (SYNC-04 Idempotency Clash):**
   * Mutation A: `payload: { chapterId: 'chap-1', progressPercentage: 70 }` ➔ `hashA`.
   * Mutation B: `payload: { chapterId: 'chap-2', progressPercentage: 95 }` ➔ `hashB`.
   * `hashA !== hashB`. Server đối chiếu với `receipt.payload_hash` ban đầu, lập tức phát hiện sai lệch nội dung và từ chối với HTTP `409 Conflict` (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`).
3. **Từ Chối Triệt Để 'undefined' (Fail-Closed at Object & Array):**
   * `{ x: 70, y: undefined }` ➔ ném lỗi `[JCS] Undefined property value not allowed at root.y`. Ngăn chặn nguy cơ sinh cùng hash với `{ x: 70 }`.
   * `[1, undefined, 3]` ➔ ném lỗi `[JCS] Sparse array or undefined element not allowed at root[1]`.
4. **Từ Chối Sparse Arrays (Mảng có phần tử rỗng / Lỗ hổng):**
   * `[1, , 3]` hoặc `new Array(3)` ➔ ném lỗi `[JCS] Sparse array or undefined element not allowed`.
5. **Từ Chối Đối Tượng Không Thuộc Chuẩn Plain JSON Object:**
   * `new Date()` (`{ x: new Date() }`) ➔ ném lỗi `[JCS] Unsupported object type 'Date'; only plain JSON objects are allowed`. Ngăn chặn việc Date bị serialize thành `{}` gây va chạm hash với object rỗng thực tế `{ x: {} }`.
   * `Map`, `Set`, `RegExp`, Error hoặc Class instances ➔ ném lỗi `[JCS] Unsupported object type`.
6. **Kiểm Tra Unicode & Từ Chối Lone Surrogates Trên Cả Keys và Values:**
   * String value chứa lone surrogate: `{ text: '\uD800' }` ➔ ném lỗi `[JCS] Invalid lone surrogate in UTF-16 string`.
   * Object key chứa lone surrogate: `{ ['\uD800']: 'val' }` ➔ ném lỗi `[JCS] Invalid lone surrogate in object key`.
   * Surrogate pairs hợp lệ (Emoji `😀`, CJK supplementary code points) ➔ được chấp nhận và serialize bình thường.
7. **Chuẩn Hóa Số Học (RFC 8785 Section 3.2.2.3):**
   * `-0` chuyển đổi thành `0`.
   * `NaN`, `Infinity`, `-Infinity` ➔ ném lỗi `[JCS] Invalid non-finite number`.
   * Native `bigint` ➔ ném lỗi `[JCS] Native bigint not allowed; must be serialized as decimal string`.
8. **Bắt Buộc Payload Hợp Lệ (Strict Payload Requirement):**
   * Mutation thiếu payload (`payload: undefined` hoặc không khai báo thuộc tính) ➔ ném lỗi fail-closed, tuyệt đối không âm thầm biến thành `{}`.
   * `payload: null` hoặc `payload: []` hoặc payload kiểu nguyên thủy ➔ ném lỗi fail-closed.
9. **Phát Hiện Cấu Trúc Tham Chiếu Vòng (Cyclic References):**
   * Object hoặc Array chứa vòng lặp (`a.self = a`) ➔ ném lỗi `[JCS] Cyclic reference detected`.

---

### 3.2. [P0 Fix] Giao Thức Phân Trang Snapshot Nhất Quán (Optimistic Restart with REPEATABLE READ READ ONLY Isolation)

#### Đánh giá giải pháp:
Chọn phương án **Optimistic Snapshot Restart** kết hợp mức cô lập giao dịch **`REPEATABLE READ READ ONLY`** trong PostgreSQL. Phương án này bảo đảm 100% tính nhất quán point-in-time mà không cần lưu trữ bảng phụ hay ảnh chụp tốn kém bộ nhớ.

#### Quy Trình Giao Thức & Mức Cô Lập Giao Dịch:
```text
Client (Web / Mobile)                           Core API Server (PostgreSQL)
       │                                                      │
       │── 1. GET /sync/snapshot?limit=200 ──────────────────>│ BEGIN TRANSACTION ISOLATION LEVEL
       │                                                      │ REPEATABLE READ READ ONLY;
       │                                                      │ Read current_sync_rev = 100 (Pinned)
       │                                                      │ Query Page 1 entities at rev 100
       │                                                      │ COMMIT (Consistent MVCC Snapshot)
       │<─ 2. Response: rev: "100", nextCursor(rev: 100) ─────│
       │ (Ghi Page 1 vào local snapshot_staging_store)        │
       │                                                      │ [Thiết bị khác commit rev 101]
       │── 3. GET /sync/snapshot?cursor=nextCursor ──────────>│ BEGIN TRANSACTION ISOLATION LEVEL
       │                                                      │ REPEATABLE READ READ ONLY;
       │                                                      │ Read current_sync_rev = 101
       │                                                      │ Check: 101 !== cursor.rev (100)
       │                                                      │ ROLLBACK;
       │<─ 4. HTTP 409 SNAPSHOT_INVALIDATED ──────────────────│ Torn snapshot prevented!
       │                                                      │
       │ (Wipe snapshot_staging_store)                        │
       │── 5. GET /sync/snapshot?limit=200 (Restart Page 1) ─>│ BEGIN REPEATABLE READ READ ONLY ...
```

#### Quy Tắc Kỹ Thuật Bắt Buộc:
1. **Mức Cô Lập Giao Dịch Cho Từng Request Trang Snapshot:**
   * Mọi request lấy dữ liệu trang snapshot (`GET /api/v1/sync/snapshot`) **bắt buộc phải thực thi trong một transaction PostgreSQL độc lập với mức cô lập `REPEATABLE READ READ ONLY`**:
     ```sql
     BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
     ```
   * Trong cùng transaction này:
     * Đọc `current_sync_revision` từ bảng `user_sync_state`.
     * Đối với Trang 2+: Kiểm tra xem `current_sync_revision === BigInt(cursor.snapshotRevision)`. Nếu không khớp, `ROLLBACK` và trả về ngay HTTP `409 Conflict` (`SNAPSHOT_INVALIDATED`).
     * Truy vấn dữ liệu thực thể của trang đó. Nhờ mức cô lập `REPEATABLE READ`, toàn bộ các câu `SELECT` bên trong transaction quan sát cùng một MVCC snapshot duy nhất, không bị ảnh hưởng bởi các commit đồng thời.
   * **Tuyệt đối không thực hiện bất kỳ lệnh ghi dữ liệu hoặc side-effects nào** bên trong transaction đọc snapshot.
   * `COMMIT` transaction sau khi hoàn tất đọc dữ liệu.
2. **Tính Nguyên Tử Khi Ghi Thư Viện (Atomic Library Mutations):**
   * Mọi thay đổi thư viện thuộc phạm vi sync (qua Sync Hub hoặc qua các API hiện có tích hợp `SyncLogEmitter`) bắt buộc phải cập nhật `current_sync_revision` **nguyên tử trong cùng một transaction** với các thao tác ghi dữ liệu nghiệp vụ (`bookmarks`, `reading_progress`, `chapter_read_states`).
3. **Cơ Chế Khách Cục Bộ (Snapshot Staging Store):**
   * Client Web và Mobile tạo bảng tạm `snapshot_staging_store`.
   * Các trang được nạp vào staging. Nếu nhận `409 SNAPSHOT_INVALIDATED`, client **xóa sạch staging và tự động restart Trang 1**.
   * Chỉ khi nhận trang cuối cùng (`hasMore === false`):
     * Mở một Local Storage Transaction nguyên tử duy nhất:
       1. Trút toàn bộ dữ liệu staging sang live replica.
       2. Cập nhật `lastRevision = snapshotRevision`.
       3. Thực thi thuật toán Triage cho pending mutations.
       4. Xóa sạch staging.
   * Bảo đảm 100% không bao giờ tồn tại trạng thái replica bị pha trộn.

---

### 3.3. [P0 Fix] Khóa Lỗ Hổng HISTORY Epoch (Tương Thích Tuyệt Đối Với Phase 7B)

#### Phân tích & Chuẩn Hóa Điều Kiện Kiểm Tra Epoch:
* **Nguyên nhân lỗi trước đây:** Điều kiện cũ `E_tomb >= observedHistoryEpoch` sử dụng dấu `>=` khiến một thao tác đọc mới hợp lệ (được người dùng đọc sau khi xóa lịch sử, mang đúng epoch hiện hành của tombstone) cũng bị từ chối oan uổng!
* **Quy chuẩn Phase 7B (`stories.service.ts`):** 
  Phase 7B xác định `effectiveEpoch` bằng cách lấy giá trị lớn nhất giữa tombstone của truyện cụ thể và global sentinel tombstone (`00000000-0000-0000-0000-000000000000`). Sau đó thực hiện **Strict Equality Check**: `writeEpoch === effectiveEpoch`.

#### Thuật Toán Phân Xử HISTORY Epoch Chuẩn Xác Của Sync Engine:
1. **Trường bắt buộc trong Contract:** `observedHistoryEpoch: number` là **trường số nguyên bắt buộc** trong `HistoryMutationPayload` (không được để optional khi ghi nhận thao tác).
2. **Quy tắc kiểm tra tại Server (Áp dụng trong Batch Mutation Transaction):**
   ```typescript
   // 1. Tra cứu tombstone cụ thể của truyện và global sentinel
   const tombstoneRows = await manager.query(
     `SELECT COALESCE(MAX(epoch), 0) AS "effectiveEpoch"
      FROM reading_history_tombstones
      WHERE user_id = $1 AND story_id IN ($2, '00000000-0000-0000-0000-000000000000'::uuid)`,
     [userId, mutation.payload.storyId],
   );
   const effectiveEpoch = Number(tombstoneRows[0]?.effectiveEpoch ?? 0);

   // 2. Strict Equality Check theo đúng chuẩn Phase 7B
   const observedEpoch = mutation.payload.observedHistoryEpoch;
   if (
     observedEpoch === undefined ||
     !Number.isInteger(observedEpoch) ||
     observedEpoch !== effectiveEpoch
   ) {
     return {
       status: 'REJECTED_TOMBSTONE',
       reason: 'STALE_HISTORY_EPOCH',
       observedEpoch,
       effectiveEpoch,
     };
   }
   ```
3. **Ý nghĩa phân xử:**
   * Nếu người dùng xóa lịch sử truyện A ➔ CSDL ghi nhận tombstone với `epoch = 5` (effectiveEpoch = 5).
   * Người dùng đọc lại truyện A trên thiết bị mới hoặc sau đó ➔ client quan sát `effectiveEpoch = 5`, gửi mutation đọc với `observedHistoryEpoch = 5` ➔ **HỢP LỆ (5 === 5) ➔ APPLIED**.
   * Thiết bị Mobile cũ offline từ trước khi xóa lịch sử (lúc đó epoch = 4), gửi lại lịch sử đọc cũ mang `observedHistoryEpoch = 4` ➔ **BỊ TỪ CHỐI (4 !== 5) ➔ REJECTED_TOMBSTONE**.
   * Triệt tiêu hoàn toàn nguy cơ phục sinh lịch sử đọc cũ, đồng thời **không bao giờ chặn nhầm các thao tác đọc mới hợp lệ**!

---

### 3.4. [P1 Fix] Quy Định Bất Biến Của Mutation ID Sau Reconcile / Rejection

* Bản ghi trong `sync_mutation_receipts` có khóa `(user_id, client_id, mutation_id)` là **bất biến vĩnh viễn (Immutable)**.
* Nếu client cố tình gửi lại `mutationId` cũ với `baseServerRevision` mới (hoặc payload sửa đổi), hàm `computeCanonicalMutationHash` sẽ sinh hash khác với `receipt.payload_hash` trong CSDL ➔ Server sẽ từ chối với HTTP `409 Conflict` (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`).
* **Quy tắc bắt buộc:**
  * Khi client thực hiện hòa trộn cục bộ sau 410 hoặc khi người dùng chủ động retry một thao tác đã bị từ chối:
  * Client **bắt buộc phải sinh một `mutationId` hoàn toàn mới (UUIDv4)**.
  * Mutation cũ được đánh dấu `RESOLVED_TERMINAL` trong local storage và loại khỏi hàng đợi active.

---

### 3.5. [P1 Fix] Thuật Toán GC Watermark Monotonic & Non-Null

Thuật toán dọn dẹp định kỳ chạy trong một transaction duy nhất:
```text
CutoffTime = NOW() - INTERVAL '90 days'
CandidateMinRev = (SELECT MIN(revision) FROM sync_change_log WHERE user_id = $1 AND created_at >= CutoffTime)

IF CandidateMinRev IS NOT NULL THEN
    TargetMinRevision = GREATEST(user_sync_state.min_active_revision, CandidateMinRev)
ELSE
    -- Không có mutation nào trong 90 ngày: watermark tiến thẳng lên current_sync_revision (không bao giờ NULL)
    TargetMinRevision = user_sync_state.current_sync_revision
END IF

DELETE FROM sync_tombstones WHERE user_id = $1 AND deleted_at_revision < TargetMinRevision;
DELETE FROM sync_change_log WHERE user_id = $1 AND revision < TargetMinRevision;
UPDATE user_sync_state SET min_active_revision = TargetMinRevision, last_synced_at = NOW() WHERE user_id = $1;
```

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
    payload_hash VARCHAR(64) NOT NULL, -- SHA-256 JCS Canonical Hash
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
  forceRewind?: boolean;        // Cho phép đọc lại chương cũ
}

export interface HistoryMutationPayload {
  storyId: string;
  chapterId: string;
  chapterVersionId?: string | null;
  progressPercentage: number;
  observedHistoryEpoch: number; // BẮT BUỘC: Strict Equality với effectiveEpoch của Phase 7B
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
  nextCursor: string | null;     // Signed token mã hóa { snapshotRevision, domain, offsetId }
  data: {
    bookmarks: Array<{ storyId: string; createdAt: string }>;
    readingProgress: Array<ProgressMutationPayload>;
    chapterReadStates: Array<{ 
      chapterId: string; 
      storyId: string;
      chapterVersionId?: string | null;
      maxProgressPercentage: number; 
      completedAt: string | null; 
      lastReadAt: string;
      storyHistoryEpoch: number; // Effective epoch hiện hành của truyện
    }>;
    preferences: Array<{ key: string; value: any; updatedAt: string }>;
  };
}
```

---

## 6. Ma Trận Nghiệm Thu Bắt Buộc (20 Acceptance Scenarios)

| Scenario ID | Tình huống kiểm thử | Hành động & Điều kiện | Kỳ vọng nghiệm thu (Expected Invariant) |
|---|---|---|---|
| **SYNC-01** | Hai thiết bị gửi mutation đồng thời | Web & Mobile cùng gửi batch mutation lên Server tại cùng một thời điểm. | Không race condition; PostgreSQL cấp revision tăng đơn điệu không trùng lặp; thứ tự commit hợp lệ. |
| **SYNC-02** | Retry mutation đã `APPLIED` | Client gửi lại mutation đã được xử lý thành công trước đó (cùng ID, cùng canonical hash). | Nhận trạng thái `DEDUPLICATED` kèm assigned revision gốc; không sinh side-effects hay tăng revision. |
| **SYNC-03** | Retry mutation đã bị `REJECTED` | Client gửi lại mutation trước đó đã bị `REJECTED_TOMBSTONE` hoặc `REJECTED_STALE`. | Nhận đúng kết quả từ chối ban đầu từ `sync_mutation_receipts`; **không bị biến thành DEDUPLICATED**. |
| **SYNC-04** | Tái sử dụng Mutation ID với Nested Payload khác | Client gửi mutation ID cũ nhưng sửa đổi giá trị lồng nhau (vd: `progressPercentage: 70` ➔ `95`). | JCS Serializer phát hiện sai lệch hash; trả lỗi HTTP `409 Conflict` (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`). |
| **SYNC-05** | Offline > 90 ngày với pending UPSERT cũ | Thiết bị offline 95 ngày có pending Bookmark A. Web đã xóa Bookmark A ngày 5. Client kết nối lại. | Nhận `410 SYNC_REVISION_EXPIRED`; Safe Reconcile hủy bỏ stale UPSERT của Bookmark A; **không phục sinh bookmark**. |
| **SYNC-06** | Pull phân trang khi có mutation mới phát sinh | Client đang kéo delta trang 1 thì có thiết bị khác commit thêm revision mới. | Phân trang cursor-based hoạt động ổn định; không bị nhảy cóc (skip) hay sót delta; checkpoint an toàn. |
| **SYNC-07** | Crash giữa chừng khi apply local và lưu checkpoint | Client crash ngay sau khi ghi dữ liệu cục bộ nhưng chưa kịp lưu `lastRevision`. | Khởi động lại client tiếp tục pull từ `lastRevision` cũ; logic apply cục bộ idempotent không làm hỏng dữ liệu. |
| **SYNC-08** | Lệch bố cục phiên bản chương (Version Mismatch) | Hai thiết bị đọc hai `chapterVersionId` khác layout (vd: bản scan cũ vs bản remaster mới). | Không gộp `MAX(pageIndex)` sai vị trí đọc; bảo toàn vị trí đọc tương ứng với phiên bản chương. |
| **SYNC-09** | Guest Claim Commit từ Web, Mobile thực hiện sync | Người dùng claim tài khoản khách trên Web; Mobile mở app sau đó và pull sync. | Mobile kéo được toàn bộ delta do Guest Claim sinh ra qua `SyncLogEmitter`; dữ liệu hòa trộn hoàn chỉnh. |
| **SYNC-10** | Client gửi revision vượt server hoặc hết hạn GC | Client gửi `baseServerRevision` lớn hơn server revision hiện tại hoặc nhỏ hơn `minActiveRevision`. | Fail-closed lập tức (`400 Bad Request` hoặc `410 Gone`); không cho phép dữ liệu vô căn cứ ghi vào hệ thống. |
| **SYNC-11** | Revision 64-bit vượt giới hạn safe integer của JS | Giả lập `revision = 9007199254740995` (`> 2^53 - 1`). | DTO dạng decimal string giữ nguyên vẹn 100% giá trị số; không bị JavaScript làm tròn số (truncation error). |
| **SYNC-12** | Không kích hoạt Gamification khi Sync Replay | Thực hiện sync hàng loạt 100 chương lịch sử và tiến độ đọc. | Không phát thưởng điểm kinh nghiệm (EXP), OmniCoin, hay Streak ($\Delta = 0$). |
| **SYNC-13** | Strict Equality trên Effective History Epoch | Người dùng xóa lịch sử truyện A (effectiveEpoch = 5). Thao tác đọc mới trên Web mang `observedHistoryEpoch = 5` được chấp nhận. Mobile offline gửi mutation đọc cũ mang `observedHistoryEpoch = 4`. | Mutation đọc cũ mang epoch 4 bị từ chối ngay (`4 !== 5` ➔ `REJECTED_TOMBSTONE`); thao tác đọc mới mang epoch 5 được chấp nhận; **không chặn nhầm thao tác đọc mới**. |
| **SYNC-14** | Change log trống sau GC vẫn giữ watermark hợp lệ | Người dùng không có thao tác nào trong 95 ngày. Cronjob GC chạy. | Watermark `min_active_revision` tiến lên `current_sync_revision`, **không bị NULL**; client cũ kết nối nhận đúng `410 Gone`. |
| **SYNC-15** | Repeatable Read Isolation & Optimistic Restart | Client kéo Trang 1 snapshot trong transaction `REPEATABLE READ READ ONLY`. Thiết bị khác commit mutation làm tăng revision. Client kéo Trang 2. | Server phát hiện revision thay đổi, trả về HTTP `409 SNAPSHOT_INVALIDATED`; client wipe staging và restart Trang 1 an toàn. Mọi câu SELECT trong từng trang đều quan sát MVCC snapshot nhất quán. |
| **SYNC-16** | Cùng mutation ID, payload giống nhưng domain/op khác | Client gửi mutation ID cũ với payload giống nhưng đổi từ `BOOKMARK` sang `PROGRESS` hoặc `UPSERT` sang `DELETE`. | Canonical hash kiểm tra toàn diện phát hiện sai lệch thuộc tính ➔ Chặn đứng với HTTP `409 Conflict`. |
| **SYNC-17** | Retry rejected mutation trả đúng kết quả từ chối | Client retry mutation bị `REJECTED_TOMBSTONE`. | Server tra cứu `sync_mutation_receipts` và trả về `status: 'REJECTED_TOMBSTONE'`, không biến thành `DEDUPLICATED`. |
| **SYNC-18** | Hai request cùng idempotency key bay tới đồng thời | Hai request cùng key đến trong cùng một mili-giây. | Transaction row lock / unique constraint xử lý nguyên tử: 1 request ghi receipt, request thứ hai đọc receipt; chỉ tạo 1 kết quả duy nhất. |
| **SYNC-19** | Rebase mutation cũ bằng cách đổi baseServerRevision giữ nguyên ID | Client cố tình gửi lại `mutationId` đã stale nhưng sửa `baseServerRevision`. | Thay đổi baseServerRevision làm đổi canonical hash ➔ Server chặn HTTP `409 Conflict`. Bắt buộc sinh fresh `mutationId`. |
| **SYNC-20** | JCS Conformance & Strict Domain Validation | Thử nghiệm serializer với nested payloads và toàn bộ các giá trị biên ngoài miền I-JSON (`undefined`, lone surrogates ở cả key và value, non-plain objects `Date`/`Map`/`Set`, sparse arrays, cyclic structures, `NaN`, `Infinity`, native `bigint`, missing/null payload). | Serializer bảo toàn 100% nested keys theo thứ tự UTF-16 code units; fail-closed với HTTP `400 Bad Request` khi gặp giá trị không an toàn; từ chối payload thiếu hoặc không phải plain JSON object. |

---

## 7. Phân Chia Thứ Tự Triển Khai Thống Nhất (Phase 7C Task Roadmap)

* **Phase 7C.0: Architecture & Protocol Review Gate** `[x] CLOSED / PASS`
  * Khóa 5 bất biến kỹ thuật, giải quyết triệt để các phát hiện P0/P1, chuẩn hóa fail-closed validator I-JSON & JCS Canonical Serializer, ban hành hợp đồng mạng DTO và 20 kịch bản nghiệm thu. Chính thức nghiệm thu đóng gate kiến trúc.
* **Phase 7C.1: Database Schema & Core Entities (`services/api`)** `[x] CLOSED / PASS (FROZEN CLEAN)`
  * Tạo các bảng CSDL: `user_sync_state`, `sync_change_log`, `sync_tombstones`, `sync_mutation_receipts` (Migration 0021, DDL cascade delete, check & unique constraints, indexes).
  * TypeORM Entities kèm 64-bit Decimal String Transformer hai chiều, JCS RFC 8785 Canonical Serializer & I-JSON Fail-Closed Validator, 49 unit tests, 6 integration tests, Hosted CI Run #40651915840 Green 7/7, Commit `82221b1`.
* **Phase 7C.2: Core API Sync Hub & Delta Protocol (`services/api`)** `[x] CLOSED / PASS (FROZEN CLEAN)`
  * Cài đặt các endpoints: `GET /sync/changes`, `GET /sync/snapshot` (kèm Repeatable Read Isolation & Optimistic Restart 409 Guard), `POST /sync/mutations/batch`.
  * Bộ giải quyết xung đột (Domain Conflict Resolver) và bảo vệ Tombstone Anti-Resurrection với Strict Equality Effective History Epoch Check.
  * Tích hợp `SyncLogEmitter` vào Guest Claim Commit và các API ghi thư viện hiện có.
  * Nghiệm thu chính thức tại baseline `4e9c4dbfb96a6b7957090d8a306485333014c550` (Hosted CI Run #40701295336: 7/7 Jobs Green, Core API Unit 601 PASS, Integration/E2E 303 PASS, Sync Hub PostgreSQL 13/13 PASS).
* **Phase 7C.3: Web Client Sync Reconciler (`apps/web`)** `[/] Đang Triển Khai (AUTHORIZED)`
  * Nâng cấp IndexedDB Schema (thêm `sync_meta`, `pending_mutations`, `quarantined_mutations`, `snapshot_staging_store`).
  * Điều phối đa tab qua `BroadcastChannel` bầu chọn Tab Leader thực hiện sync.
  * Cài đặt Safe 410 Full Resync Triage Reconciler (chống phục sinh bookmark & history epoch).
  * Tuân thủ triệt để: không tự động rebase stale mutation, không làm sống lại tombstone, không ghi checkpoint trước khi local apply thành công.
* **Phase 7C.4: Mobile Client Sync Reconciler (`apps/mobile`)** `[ ] Chưa làm`
  * Nâng cấp SQLite Schema (bảng `pending_sync_mutations`, `sync_metadata`, `snapshot_staging`).
  * Cài đặt `SyncWorker` chạy nền với Exponential Backoff & Connectivity Gate.
  * Cài đặt Safe 410 Full Resync Triage Reconciler (chống phục sinh bookmark & history epoch).
* **Phase 7C.5: Comprehensive Cross-Platform Sync Verification Matrix** `[ ] Chưa làm`
  * Kiểm thử tự động toàn diện 20 kịch bản nghiệm thu `SYNC-01` đến `SYNC-20` trên cả Web, Mobile và Backend.
