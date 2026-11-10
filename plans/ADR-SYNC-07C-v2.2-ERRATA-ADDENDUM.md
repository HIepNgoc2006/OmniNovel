# Canonical Architecture Errata Addendum — ADR-SYNC-07C-v2.2 (B1 & B2 Gates)

> **Document Status:** PROPOSED CANONICAL ERRATA ADDENDUM (ISOLATED TEST BRANCH `test/b2-critical-red-acceptance-harness` — PENDING GATE REVIEW, NOT MERGED/FROZEN ON MAIN)  
> **Target Subsystems:** `services/api` (Sync Engine, Claims, Stories), `packages/shared`  
> **Baselines:** ADR-SYNC-07C-v2.2 (`b698ef7`), PR #213 (`6e440e2`), PR #212 (`c440396`), B1 RED Test Harness (`4c70cd8`), B2 RED Test Harness (`5b8ca1c`)  
> **Date:** 2026-11-10  
> **Author:** OmniNovel Engineering Core  

---

## 1. Mục Đích & Phạm Vi Áp Dụng

Tài liệu này đóng vai trò phụ lục chuẩn hóa kiến trúc đề xuất (**Proposed Canonical Errata Addendum**) bổ sung cho `ADR-SYNC-07C-v2.2`, kết tinh từ các kết quả thực nghiệm E2E độc lập trên NestJS HTTP Pipeline thật, PostgreSQL test cô lập (`omninovel_test`) và Redis.

Phụ lục này được lưu trữ độc quyền trên nhánh kiểm thử cô lập `test/b2-critical-red-acceptance-harness` nhằm chuẩn bị các hợp đồng kiểm thử RED cho Patch Set B1 (Validation & Resolvers) và Patch Set B2 (SyncService, Snapshot, Dual-Delta & Cursors), ngăn ngừa tuyệt đối mọi hiện tượng trôi dạt hợp đồng (Contract Drift) hoặc sai lệch hành vi giữa Web, Mobile và Server.

> [!WARNING]
> Tài liệu này **CHƯA ĐƯỢC MERGE** vào nhánh `main` và **CHƯA ĐƯỢC PHÊ DUYỆT TRIỂN KHAI PRODUCTION**. Việc triển khai mã nguồn production B1/B2/B3 tiếp tục ở trạng thái **`HOLD`** cho đến khi Gate kiểm tra tuần tự hoàn tất PR #211 -> #212/#213.

---

## 2. Bảy Hiệu Đính Cốt Lõi (7 Canonical Errata Items)

### 2.1 Erratum 1: Cấm Triệt Để Fresh HISTORY DELETE 'all' (UUID Sentinel Enforced)

1. **Canonical Wire Sentinel:**
   - Thao tác xóa toàn bộ lịch sử đọc của người dùng (`SyncDomain.HISTORY`, `SyncOperation.DELETE`) trên wire **chỉ được phép sử dụng UUID sentinel hợp thức**:
     `entityId = '00000000-0000-0000-0000-000000000000'`.
   - Khi xóa lịch sử theo truyện, `entityId` bắt buộc phải là `storyId` (UUID v4 hợp lệ).
2. **Cấm Fresh Legacy String `'all'`:**
   - Bất kỳ mutation mới (`fresh mutation` — chưa từng có biên nhận) mang `domain = 'HISTORY'`, `operation = 'DELETE'`, `entityId = 'all'` **BẮT BUỘC bị `ValidationPipe` từ chối `HTTP 400 Bad Request`** ngay tại tầng DTO.
3. **Receipt-First Replay Boundary:**
   - Chuỗi legacy `entityId = 'all'` **CHỈ** được chấp nhận trả về `HTTP 200 DEDUPLICATED` khi và chỉ khi bộ ba `(userId, clientId, mutationId)` đã tồn tại trong `sync_mutation_receipts` và có canonical JCS SHA-256 hash khớp 100%.
4. **Không Thêm Bản Ghi Mới Mang `'all'`:**
   - Kể từ Patch Set B1, server **tuyệt đối không tạo mới** bất kỳ bản ghi `sync_change_log` hay `sync_tombstones` nào mang `entity_id = 'all'`.
   - Xóa bỏ hoàn toàn nhánh dual-write legacy `'all'` trong `SyncService.pushMutations`.

---

### 2.2 Erratum 2: Quy Trình Xử Lý Biên Nhận Trước Cho Mutation Cũ (Receipt-First Architecture)

1. **Vấn Đề Đã Xác Minh:**
   - Khi áp dụng kiểm tra DTO nghiêm ngặt của B1 (`observedHistoryEpoch` bắt buộc trên `HISTORY UPSERT`, cấm `PROGRESS entityId = storyId:chapterId`), `ValidationPipe` của NestJS đã chặn đứng `HTTP 400` các yêu cầu retry hợp lệ của client cũ **TRƯỚC KHI** request tới được `SyncService` để tra cứu bảng `sync_mutation_receipts`.
2. **Hợp Đồng Receipt-First Bắt Buộc:**
   - **Tầng 1 (Envelope & Envelope JCS Non-Mutating Validation):** Kiểm tra cấu trúc cơ bản (`clientId`, `mutationId`, `domain`, `operation`, `baseServerRevision`, `payload` là plain JSON object).
   - **Tầng 2 (Durable Receipt Lookup First):**
     - Tính JCS hash trên payload nguyên bản.
     - Tra cứu `sync_mutation_receipts` theo `(userId, clientId, mutationId)`:
       - Nếu tồn tại và **khớp hash**: Trả ngay durable receipt gốc (`DEDUPLICATED` kèm `assignedRevision` gốc, hoặc giữ nguyên mã từ chối ban đầu `REJECTED_TOMBSTONE` / `REJECTED_STALE` / `DOMAIN_NOT_SUPPORTED`). Tuyệt đối không biến `REJECTED_*` thành `DEDUPLICATED`.
       - Nếu tồn tại nhưng **lệch hash**: Ném ngay `HTTP 409 Conflict` (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`).
   - **Tầng 3 (Strict Canonical DTO Validation):**
     - Chỉ áp dụng bộ kiểm tra khắt khe của B1 (bắt buộc `observedHistoryEpoch`, cấm colon, cấm extra nested fields qua `forbidNonWhitelisted`) cho các **Fresh Mutations** (chưa có receipt).

---

### 2.3 Erratum 3: Tính Bất Biến Của Payload & Serializer JCS RFC 8785

1. **Bảo Toàn Raw Payload Trước Khi Hashing:**
   - Tuyệt đối **không được mutate, format, normalize hay tự động `.trim()`** bất kỳ trường nào trong payload trước hoặc trong quá trình tính JCS SHA-256 hash.
   - Bất kỳ sự thay đổi ngầm định nào đối với payload trước khi hashing sẽ làm sai lệch chữ ký nhân quả của client, dẫn tới lỗi sai `409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH` khi client retry.
2. **Không Tự Động `.trim()` Khóa `PREFERENCE`:**
   - `PreferenceConflictResolver` và `SyncService` không được phép gọi `.trim()` âm thầm trên `preferenceKey`.
   - Nếu `entityId` hoặc `payload.key` chứa khoảng trắng đầu/cuối (ví dụ `' theme '`), request **phải bị từ chối `HTTP 400 Bad Request`** ngay tại DTO validator.
   - Giá trị lưu vào `user_preferences.key` và `sync_change_log.entity_id` phải thống nhất 100% với khóa đã hash.

---

### 2.4 Erratum 4: Thứ Tự Ưu Tiên Tombstone Cho `PREFERENCE` (Anti-Resurrection)

1. **Nguyên Tắc Precedence Bắt Buộc:**
   - Trong `PreferenceConflictResolver.resolve`, kiểm tra **Tombstone Conflict (`tombstoneRevision`) BẮT BUỘC PHẢI CHẠY TRƯỚC** kiểm tra Whitelist / Stale Key.
2. **Ngăn Chặn Tái Phục Sinh Dữ Liệu Đã Xóa:**
   - Nếu `context.tombstoneRevision !== null` và `BigInt(mutation.baseServerRevision) < BigInt(tombstoneRevision)`:
     - BẮT BUỘC trả về `REJECTED_TOMBSTONE` (`reason: 'TOMBSTONE_CONFLICT'`).
     - Tuyệt đối không cho phép ghi đè (`APPLIED`) đưa cấu hình đã xóa trở lại cơ sở dữ liệu.
3. **Bảo Toàn Bằng Chứng Khóa Lịch Sử:**
   - Với các khóa cấu hình lịch sử (ví dụ `pref:a:b`) nằm dưới tombstone còn hiệu lực:
     - Khi client gửi mutation với `baseServerRevision < tombstoneRevision`, server phải trả `REJECTED_TOMBSTONE (TOMBSTONE_CONFLICT)`, KHÔNG được trả `REJECTED_STALE (PREFERENCE_KEY_NOT_SUPPORTED)`.

---

### 2.5 Erratum 5: Phân Tách Quyền Lực GuestClaim BOOKMARK Anti-Resurrection (B2 Pre-Delta Gate)

1. **Tách Biệt Lịch Sử Đọc & Dấu Trang:**
   - Bảng `reading_history_tombstones` chỉ đại diện cho việc xóa lịch sử đọc (`HISTORY`) và tiến độ đọc (`PROGRESS`).
   - Việc có dòng tombstone trong `reading_history_tombstones` **TUYỆT ĐỐI KHÔNG ĐƯỢC CHẶN** việc import bookmark hợp lệ của người dùng khách (`GuestClaim`).
2. **Kiểm Tra Độc Lập `sync_tombstones(domain='BOOKMARK')`:**
   - `GuestClaimService` bắt buộc phải truy vấn bảng `sync_tombstones` với `domain = 'BOOKMARK'` để phát hiện các truyện mà tài khoản đích đã chủ động xóa bookmark trên Cloud.
3. **Cơ Chế Conflict / Quarantine Tại Bản Xem Trước (`prepareClaim`):**
   - Mọi bookmark của khách trùng với truyện đã bị xóa trên Cloud (`BOOKMARK` tombstone còn hiệu lực) **KHÔNG ĐƯỢC PHÉP tự động nạp (`bookmarksToImport` không tăng)**.
   - Server phải đưa các truyện này vào danh sách `bookmarkConflicts` trên `GuestClaimPreviewResponseDto` để hiển thị cảnh báo cho người dùng.
4. **Bảo Toàn Ý Định Người Dùng Tại Bước Thực Thi (`commitClaim`):**
   - Mặc định (`KEEP_CLOUD`): Server không phục sinh bookmark đã xóa.
   - Chỉ khi người dùng chọn rõ ràng `USE_GUEST`, server mới ghi nhận bookmark và phát delta `BOOKMARK UPSERT` mới.

---

### 2.6 Erratum 6: Chuẩn Hóa Ánh Xạ Lỗi HTTP JSON & Kích Thước Giới Hạn

1. **HTTP `413 PAYLOAD_TOO_LARGE`:**
   - Khi payload vượt quá `2 MB` (`PayloadTooLargeError: request entity too large` từ Express), `GlobalExceptionFilter` bắt buộc phải bắt exception này và trả về chuẩn `HTTP 413` với body `{ error: { code: 'PAYLOAD_TOO_LARGE', message: '...' } }`, tuyệt đối không để rơi vào unhandled `500 INTERNAL_SERVER_ERROR`.
2. **HTTP `400 INVALID_JSON_PAYLOAD`:**
   - Khi nhận JSON gãy cú pháp hoặc token bare `NaN` / bare `Infinity` từ client, `GlobalExceptionFilter` phải chuẩn hóa mã lỗi thành `{ error: { code: 'INVALID_JSON_PAYLOAD', message: '...' } }`.
3. **Phân Tách Non-Finite Numbers & Lone Surrogates:**
   - Số overflow `1e309` (được V8 `JSON.parse` đánh giá thành `Infinity`) hoặc ký tự UTF-16 lone surrogate (`\uD800`) phải bị từ chối bằng `HTTP 400 Bad Request` ngay tại DTO validator, không để lọt vào `SyncService` gây throw `Error: [JCS]` làm sập request thành `500 INTERNAL_SERVER_ERROR`.
4. **Phòng Chống Tấn Công Qua Khóa Nguyên Mẫu (Prototype-Key Fail-Closed Guard):**
   - Các khóa nhạy cảm `__proto__`, `constructor`, `prototype` trong JSON thô phải bị từ chối `HTTP 400 Bad Request` ngay tại middleware tiền xử lý, ngăn chặn lỗi `TypeError: targetType is not a constructor` trong `class-transformer` gây DoS `500`.
5. **Bảo Toàn Metadata Trên Lỗi Idempotency:**
   - Khi trả về `HTTP 409 Conflict` (`IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`), `GlobalExceptionFilter` bắt buộc phải đưa `'mutationId'` vào `PUBLIC_ERROR_META_FIELDS` để client xác định chính xác mutation bị từ chối.

---

### 2.7 Erratum 7: Chuẩn Hóa Phiên Bản HMAC Cursor, Phân Loại Lỗi & Điều Kiện Tiên Quyết Response Serialization

1. **Duy Trì Phiên Bản Cursor `v: 1` Bất Biến (Không Giả Định `v: 'v2'`):**
   - Theo chuẩn `ADR-SYNC-07C-v2.2`, `CURRENT_VERSION = 1` được duy trì nghiêm ngặt trong `HmacCursorHelper`.
   - Cấu trúc cursor payload hợp thức:
     ```ts
     interface SnapshotCursorPayload {
       v: 1;                 // Luôn là 1, tuyệt đối không dùng 'v2'
       uid: string;          // User ID
       srev: string;         // Snapshot Revision (decimal string)
       mrev?: string;        // Watermark Revision (decimal string)
       domain: SyncDomain;   // Domain đang phân trang
       key: string;          // Cursor position key
       exp: number;          // Epoch timestamp seconds
     }
     ```
2. **Hợp Thức Hóa Watermark `mrev`:**
   - `mrev = '0'` là giá trị watermark hoàn toàn **HỢP LỆ** (trạng thái ban đầu khi chưa từng chạy Garbage Collection).
   - `mrev` âm (`'-1'`), sai định dạng (`'abc'`, `'1.5'`, `' 10 '`, số nguyên `10`) hoặc tràn số (`> 9223372036854775807n`) **BẮT BUỘC bị từ chối `HTTP 400 Bad Request`** (`code: 'CURSOR_INVALID_REVISION'`).
3. **Xử Lý Signed Legacy `v1` Cursor Thiếu `mrev`:**
   - Cursor `v1` có chữ ký HMAC hợp lệ nhưng thiếu `mrev` (`payload.mrev === undefined`) đại diện cho client đang giữ cursor của hệ thống cũ.
   - `SyncService.getSnapshot` từ chối an toàn với **HTTP 409 Conflict** (`code: 'SNAPSHOT_INVALIDATED'`, `reason: 'CURSOR_WATERMARK_UPGRADE_REQUIRED'`), kèm metadata `minActiveRevision` và `currentServerRevision` để client dọn staging store và khởi động lại từ Page 1.
4. **Hệ Thống Phân Loại Lỗi (Error Taxonomy):**
   - **Tầng Causal Resolver (Batch Item-Level Rejection):** Trả về **HTTP 200 OK** cho toàn batch, item mutation nhận trạng thái `REJECTED_TOMBSTONE` kèm `reason: 'TOMBSTONE_CONFLICT'` (hoặc `MISSING_HISTORY_EPOCH_PROOF`, `STALE_HISTORY_EPOCH`).
   - **Tầng Mutation Idempotency (Envelope Collision):** Trả về **HTTP 409 Conflict** với mã lỗi `code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH'`, kèm `error.meta.mutationId`.
   - **Tầng Snapshot Pagination Watermark (Cursor Shift / Pruned):** Trả về **HTTP 409 Conflict** với mã lỗi `code: 'SNAPSHOT_INVALIDATED'`, kèm `error.meta.reason`, `error.meta.minActiveRevision`, `error.meta.cursorMinActiveRevision`, `error.meta.currentServerRevision`.
5. **Điều Kiện Tiên Quyết Triển Khai Cho Response Serialization (`GlobalExceptionFilter`):**
   - `GlobalExceptionFilter` tại `services/api/src/common/filters/http-exception.filter.ts` lọc metadata công khai theo danh sách kiểm soát `PUBLIC_ERROR_META_FIELDS`.
   - Để các mã lỗi `409 Conflict` (cả Idempotency lẫn Snapshot) truyền tải đầy đủ ngữ cảnh cho Web và Mobile mà không bị filter triệt tiêu, mảng allowlist bắt buộc phải được mở rộng khi triển khai B1/B2:
     ```ts
     const PUBLIC_ERROR_META_FIELDS = [
       'currentVersion',
       'expectedVersion',
       'reviewRevision',
       'materializedRevision',
       'retryAfter',
       // --- B1/B2 Sync Error Prerequisite Fields ---
       'mutationId',
       'reason',
       'minActiveRevision',
       'cursorMinActiveRevision',
       'currentServerRevision',
     ] as const;
     ```
   - Mọi metadata công khai được đóng gói thống nhất tại trường `error.meta` trong response JSON.

---

## 3. Ma Trận Nghiệm Thu Baseline RED / PASS (B2 Test Harness)

Bộ kiểm thử RED được thực thi tại `services/api/test/b2-critical-red-acceptance.e2e-spec.ts` (15 tests) kết hợp `b2-guest-claim-bookmark-tombstone.e2e-spec.ts` (2 tests).

Tổng cộng: **17 tests (5 baseline PASS / 12 expected RED)**.

| Test ID | Hạng mục | Baseline Result | Expected B2 Behavior |
| :--- | :--- | :--- | :--- |
| `DUAL-DELTA-01` | Dual-Delta Commit | **RED** | Ghi đồng thời 2 rows delta (`PROGRESS` r+1, `HISTORY` r+2) trong 1 TX, receipt mang `r+2` |
| `DUAL-DELTA-02` | Dual-Delta Replay | **RED** | Replay mutation trả `200 DEDUPLICATED` với `assignedRevision = r+2` |
| `DUAL-DELTA-03` | Dual-Delta forceRewind | **RED** | `forceRewind = true` chỉ sinh 1 delta `PROGRESS` ($r+1$), không sinh delta `HISTORY` |
| `SNAP-SIX-01` | Six-Domain Envelope | **RED** | Snapshot trả đủ 6 domains: bookmarks, progress, chapterReadStates, preferences, historyEpochs, tombstones |
| `SNAP-SIX-02` | REG-17 Keyset Pagination | **RED** | 11 DB rows thành 9 wire items qua 5 pages (limit=2), phân trang tuần tự qua ranh giới cả 6 domain |
| `SNAP-SIX-03` | REG-17 Subcase (limit=3) | **RED** | Không ngắt sớm khi page 1 dừng đúng ranh giới domain `PREFERENCE`; trả `hasMore: true` |
| `CUR-01` | HMAC Cursor Validation | **RED** | `mrev = '-1'` bị từ chối `400 CURSOR_INVALID_REVISION` |
| `CUR-02` | HMAC Cursor Validation | **RED** | `mrev` malformed (`'abc'`, `'1.5'`, `' 10 '`, numeric `10`) bị từ chối `400 CURSOR_INVALID_REVISION` |
| `CUR-03` | HMAC Cursor Validation | **RED** | `mrev` vượt PostgreSQL BIGINT max bị từ chối `400 CURSOR_INVALID_REVISION` |
| `CUR-04` | HMAC Cursor Validation | **PASS** | Cursor với `mrev = '0'` được chấp nhận (HTTP 200); chữ ký bị tamper bị từ chối `400 CURSOR_SIGNATURE_INVALID` |
| `CUR-05` | HMAC Cursor Upgrade | **RED** | Legacy v1 cursor thiếu `mrev` bị từ chối `409 SNAPSHOT_INVALIDATED` (`reason: 'CURSOR_WATERMARK_UPGRADE_REQUIRED'`) |
| `REG-18` | Concurrent GC Invalidation | **RED** | Khi GC nâng `min_active_revision > mrev`, request bị từ chối `409 SNAPSHOT_INVALIDATED` ngăn torn snapshot |
| `PROD-01` | Server Producer | **PASS** | `StoriesService.saveReadingProgress` gắn đúng `observedHistoryEpoch` |
| `PROD-02` | Server Producer | **PASS** | Canonical wire: HISTORY $\rightarrow$ `chapterId`, PROGRESS $\rightarrow$ `storyId` |
| `PROD-03` | Server Producer | **PASS** | `forceRewind` không ghi đè giảm `chapter_read_states.max_progress_percentage` |
| `GUEST-BM-01` | GuestClaim Isolation | **PASS** | `HISTORY` tombstone không chặn import bookmark của guest |
| `GUEST-BM-02` | GuestClaim Tombstone | **RED** | `BOOKMARK` tombstone trong cloud chặn auto-import bookmark của guest, chuyển sang conflict |
