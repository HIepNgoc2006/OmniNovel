# Canonical Architecture Errata Addendum — ADR-SYNC-07C-v2.2 (B1 & B2 Gates)

> **Document Status:** CANONICAL SPECIFICATION & ERRATA ADDENDUM (FROZEN)  
> **Target Subsystems:** `services/api` (Sync Engine, Claims, Stories), `packages/shared`  
> **Baselines:** ADR-SYNC-07C-v2.2 (`b698ef7`), PR #213 (`6e440e2`), PR #212 (`c440396`), B1 RED Test Harness (`4c70cd8`)  
> **Date:** 2026-11-10  
> **Author:** OmniNovel Engineering Core  

---

## 1. Mục Đích & Phạm Vi Áp Dụng

Tài liệu này đóng vai trò phụ lục chuẩn hóa kiến trúc chính thức (**Canonical Errata Addendum**) bổ sung cho `ADR-SYNC-07C-v2.2`, kết tinh từ các kết quả thực nghiệm E2E độc lập trên NestJS HTTP Pipeline thật, PostgreSQL test cô lập (`omninovel_test`) và Redis.

Phụ lục này khóa cứng các quy tắc bất biến cho quá trình triển khai Patch Set B1 (Validation & Resolvers) và Patch Set B2 (SyncService, Snapshot, Dual-Delta & Cursors) nhằm ngăn ngừa tuyệt đối mọi hiện tượng trôi dạt hợp đồng (Contract Drift) hoặc sai lệch hành vi giữa Web, Mobile và Server.

---

## 2. Sáu Hiệu Đính Cốt Lõi (6 Canonical Errata Items)

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
