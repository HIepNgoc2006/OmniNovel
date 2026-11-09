# ADR-SYNC-07C-v2.2 — Cross-Platform Sync Contract Closure (Final Corrections)

> **Trạng thái:** `ACCEPTED WITH FINAL CORRECTIONS`  
> **Phạm vi phê duyệt hiện tại:** **CHỈ Patch Set A (`packages/shared`)**. Các Patch Set `B1`, `B2`, `B3`, Web Step 5.2d và Mobile Stage 2 **CHƯA ĐƯỢC PHÊ DUYỆT** cho tới khi Gate kiểm tra hoàn tất Patch Set A.  
> **Baselines đối chiếu:**
> - Web P1-01 (`origin/main`): `a695a1eb2d12038c0e27fc2d9611dc3b3dc66c01` (`7/7 CI PASS`)
> - Core API Remediation PR `#212`: `c440396f401f7f5bb5bb660425a5412481848b2e` (Technical PASS, chưa merge)
> - Security Fail-Closed PR `#211`: `2b20e94` / `3c09b1e` (P0 fix verified, chưa merge)
> - Mobile Stage 1B PR `#209`: `d633729` (Stage 1B Technical PASS, chưa merge)

---

## 1. Bối Cảnh & Khấu Trừ Hiện Trạng (`c440396` vs Patch Sets)

Nhánh Core API PR `#212` (`c440396`, tách từ `bede310` trước commit Web P1-01 `a695a1e`) đã hoàn thành và kiểm thử 3 hạng mục:
1. `ProgressConflictResolver.buildServerWinningPayload(...)`: giữ nguyên full server payload (`readingMode`, `anchorBlockId`, `textOffset = 0`, ...) trên `CONFLICT_MERGED` (cả Case 1 & Case 2), loại bỏ `...payload` leakage.
2. `SyncService.getChanges(...)`: bọc trong giao dịch `REPEATABLE READ READ ONLY` với biên `revision > $2 AND revision <= $3` (`currentServerRevision`) + test biên HTTP `400 SYNC_REVISION_AHEAD` / `410 SYNC_REVISION_EXPIRED`.
3. `SyncService.pushMutations(...)`: sửa `payload.textOffset ?? null` khi upsert `reading_progress`.

Các phần còn lại được đóng gói thành chuỗi PR tuần tự độc lập:
- **Patch Set A (`packages/shared` — APPROVED):** Định nghĩa hợp đồng Six-Domain Snapshot (`SnapshotHistoryEpochItem`, `SnapshotTombstoneItem`, `globalHistoryEpoch`, `historyEpochs`, `tombstones` và các type helpers / type guards tương thích ngược). Không thay đổi HTTP DTO runtime, `SyncService`, `HmacCursorHelper`, resolvers hay Mobile.
- **Patch Set B1 (`services/api` Validation & Resolvers — PENDING GATE):** Fail-closed `MISSING_HISTORY_EPOCH_PROOF`, `INVALID_HISTORY_EPOCH`, `PreferenceConflictResolver` tombstone guard, nested `forbidNonWhitelisted` + `DELETE` allowlist DTOs, canonical wire `HISTORY UPSERT entityId = chapterId` & `PROGRESS entityId = storyId`.
- **Patch Set B2 (`services/api` SyncService, StoriesService, Snapshot & Cursor — PENDING GATE):** Dual-Delta nguyên tử (`PROGRESS` + `HISTORY`), `StoriesService.saveReadingProgress` gắn `observedHistoryEpoch`, 6-domain Snapshot (`globalHistoryEpoch`, `historyEpochs`, `tombstones`, sửa bug `PREFERENCE` ngắt sớm, JSON tuple cursor), HMAC Cursor `mrev` pinning (`409 SNAPSHOT_INVALIDATED`), cập nhật assertions của `Task A + C` trong `c440396` sang dual-delta (`'2'`, `'4'`, `'6'`).
- **Patch Set B3 (`services/api` Sync GC Worker — PENDING GATE):** Worker thu gom `sync_change_log` & `sync_tombstones`, nâng `min_active_revision <= current_sync_revision`, bảo toàn vĩnh viễn `reading_history_tombstones` / `reading_history_epoch_counters`, kèm Snapshot Active Grace (`900s` cooldown).

---

## 2. Năm Hiệu Chỉnh Kiến Trúc Cuối Cùng (Final ADR v2.2 Corrections)

### 2.1 Khóa Thứ Tự Cold Bootstrap (Atomic Fail-Closed Commit Order)

Giai đoạn tải phân trang (`GET /api/v1/sync/snapshot`) chỉ ghi vào `snapshot_staging_store` khi `authoritativeBaselineStatus === 'BOOTSTRAPPING'`, tuyệt đối không chạm shadow, `pending_mutations` hay trạng thái `READY`.

Khi đã gom đủ mọi trang có `srev` và `mrev` nhất quán, `commitAuthoritativeSnapshot` BẮT BUỘC thực thi trong **một IndexedDB `readwrite` transaction / SQLite transaction duy nhất** khóa toàn bộ các store liên quan theo đúng thứ tự 4 bước bất biến sau:

1. **Bước 1 — Validate Snapshot / Session / Scope (Fail-Closed Pre-Write Gate):**
   - Gọi `checkAdmission?.()` trước khi mở transaction và ngay đầu transaction.
   - Kiểm tra `ownerScope` thuộc `account:<userId>` khớp phiên đăng nhập hiện hành (chặn tuyệt đối `guest:*`).
   - Kiểm tra `sync_meta.authoritativeBaselineStatus === 'BOOTSTRAPPING'` và `sessionId` khớp phiên staging đang mở.
   - Kiểm tra decimal BIGINT: `isValidRevisionString(snapshotRevision)`, `isValidRevisionString(minActiveRevision)`, và `BigInt(minActiveRevision) <= BigInt(snapshotRevision)`.
   - Kiểm tra hợp đồng Six-Domain Snapshot (`isSixDomainSyncSnapshotResponse` invariants): `globalHistoryEpoch` nguyên `>= 0`; `historyEpochs[]` không chứa sentinel `00000000-0000-0000-0000-000000000000`; `tombstones[]` không chứa `FOLLOW` hoặc `'HISTORY:all'`; mọi tombstone trong `tombstones[]` có `BigInt(deletedAtRevision) >= BigInt(minActiveRevision)`.
2. **Bước 2 — Materialize Authoritative Baseline:**
   - Xóa trắng replica cũ trong `sync_authoritative_replicas` và `sync_tombstones` của `ownerScope`.
   - Nạp toàn bộ bản ghi authoritative từ 6 miền (`BOOKMARK`, `PROGRESS`, `CHAPTER_READ_STATE`, `PREFERENCE`, `HISTORY_TOMBSTONE`, `SYNC_TOMBSTONE`).
   - Xây dựng `effectiveHistoryEpochs`: seed `{ '00000000-0000-0000-0000-000000000000': globalHistoryEpoch }`, gộp toàn bộ `historyEpochs[]` và `chapterReadStates[].storyHistoryEpoch` (dùng `max` nếu trùng key; không suy đoán epoch ngoài bằng chứng snapshot).
   - Cập nhật legacy read stores (`bookmarks`, `progress`, `history`, `preferences`) phản ánh chân lý server mới (không để pending xung đột làm ô nhiễm shadow).
3. **Bước 3 — Triage Toàn Bộ `pending_mutations`:**
   - Duyệt toàn bộ `pending_mutations` thuộc `ownerScope`:
     - **`ACTIVE_PENDING` (Giữ lại trong `pending_mutations`):** Chỉ giữ khi thỏa đồng thời:
       - `BigInt(minActiveRevision) <= BigInt(m.baseServerRevision) <= BigInt(snapshotRevision)`
       - Không tồn tại tombstone cho entity (`BigInt(tombstone.deletedAtRevision) > BigInt(m.baseServerRevision)`)
       - Nếu `HISTORY UPSERT`: `m.payload.observedHistoryEpoch === effectiveEpoch(storyId)`
       - Nếu `PROGRESS UPSERT`: `effectiveEpoch(storyId) === 0` hoặc `(Number.isInteger(m.payload.observedHistoryEpoch) && m.payload.observedHistoryEpoch === effectiveEpoch(storyId))`
     - **`QUARANTINED` (Move nguyên tử `pending_mutations` → `quarantined_mutations`, `triageStatus = 'PENDING'`):** Bất kỳ mutation nào vi phạm các điều kiện trên được chuyển nguyên vẹn (giữ `mutationId`, `baseServerRevision`, `payload`, `originalCreatedAt`, `causalEvidence`) sang `quarantined_mutations` với `rejectionStatus = 'HTTP_410_GONE'` (`BASE_REVISION_EXPIRED`) hoặc `'REJECTED_TOMBSTONE'` (`TOMBSTONE_CONFLICT` / `MISSING_HISTORY_EPOCH_PROOF` / `STALE_HISTORY_EPOCH` / `INVALID_HISTORY_EPOCH`). **Tuyệt đối không xóa vĩnh viễn dữ liệu offline chưa được người dùng xác nhận.**
4. **Bước 4 — Set `READY` Cuối Cùng Trong Cùng Atomic Transaction:**
   - Sau khi Bước 1–3 hoàn tất trong transaction, mới ghi `sync_meta` với `authoritativeBaselineStatus = 'READY'`, `lastSyncedServerRevision = snapshotRevision`, `minActiveRevision`, `effectiveHistoryEpochs`, đồng thời xóa `snapshot_staging_store` của `sessionId`.
   - **Bất biến Rollback Toàn Phần:** Bất kỳ lỗi nào phát sinh ở Bước 1, 2, 3 hoặc 4 (lỗi parse, `QuotaExceeded`, mất admission giữa TX, hay crash hook trước commit) BẮT BUỘC gọi `tx.abort()` / rollback SQLite transaction → khôi phục nguyên vẹn 100% trạng thái tiền-commit (`authoritativeBaselineStatus !== 'READY'`, không mất pending, không ghi shadow/READY nửa vời). Khi khởi động lại, `recoverInterruptedBootstrapToUninitialized` đưa `BOOTSTRAPPING` về `UNINITIALIZED` an toàn.

---

### 2.2 Khóa Vòng Đời Quarantine (Quarantine Lifecycle & GC Unblock)

1. **Cấm tự động requeue mutation cũ:** Nghiêm cấm đưa ngược bản ghi `REJECTED_TOMBSTONE`, `REJECTED_STALE`, hoặc `HTTP_410_GONE` từ `quarantined_mutations` về `pending_mutations` với `mutationId` cũ hoặc `baseServerRevision` cũ.
2. **Định nghĩa chính thức trạng thái `APPROVED` (Phát sinh `mutationId` MỚI):**
   - Khi người dùng xác nhận giữ/áp dụng lại một mutation cách ly `q_old` (`triageStatus === 'PENDING'`), hệ thống mở **1 transaction nguyên tử**:
     - Tạo bản ghi `PendingMutation` **MỚI hoàn toàn**: `mutationId = uuidv4()` (khác `q_old.mutationId`), `baseServerRevision = current sync_meta.lastSyncedServerRevision` (`>= minActiveRevision` & `>= tombstone.deletedAtRevision`), bổ sung `observedHistoryEpoch = effectiveEpoch(storyId)` (nếu là `PROGRESS`/`HISTORY`), giữ nguyên intent đọc của user.
     - Cập nhật `q_old` thành `triageStatus = 'APPROVED'` với `causalEvidence = { triageApproved: true, validatedRevision: currentServerRevision, observedEpoch: effectiveEpoch(storyId), triageReason: 'USER_REAPPLIED_AS_NEW_MUTATION', evidence: { ...q_old.causalEvidence?.evidence, replacementMutationId: newMutationId } }`.
     - Giữ nguyên `originalCreatedAt` bất biến của `q_old`.
3. **Không để `APPROVED` giữ GC watermark vô hạn:**
   - Trong tính toán `safeGcFloor` của GC cục bộ (`gcAuthoritativeTombstones`):
     - **CHỈ** các bản ghi `quarantined_mutations` ở trạng thái **`triageStatus === 'PENDING'`** (chưa xử lý) mới đóng góp `q.baseServerRevision` vào `floorCandidates`.
     - Cả **`'APPROVED'`** lẫn **`'DISCARDED'`** đều là **trạng thái triage đã kết thúc (terminal resolved states)** và **BỊ LOẠI KHỎI `floorCandidates`**. Mutation thay thế `replacementMutationId` tự mang `baseServerRevision` hiện hành trong `pending_mutations`.
     - Khi `replacementMutationId` nhận `APPLIED`/`DEDUPLICATED` hoặc hết cửa sổ lưu vết cục bộ, bản ghi `'APPROVED'`/`'DISCARDED'` có thể được dọn an toàn.
4. **Chuẩn hóa schema `CausalTriageProof`, `originalCreatedAt`, `causalEvidence` giữa Web và Mobile:**

| Khái niệm hợp đồng | Web TypeScript (`indexed-db-client.ts`) | Mobile Dart (`sync_models.dart`) | Bất biến Cross-Platform |
| :--- | :--- | :--- | :--- |
| **`CausalTriageProof`** | `{ observedEpoch?: number; validatedRevision?: string; triageApproved: boolean; triageReason?: string; evidence?: Record<string, unknown>; }` | `class CausalTriageProof { int? observedEpoch; String? validatedRevision; bool triageApproved; String? triageReason; Map<String, Object?>? evidence; }` | Phải ghi nhận ít nhất `triageApproved` và `evidence` chứa `tombstoneRevision`/`effectiveEpoch`/`snapshotMinActiveRevision`; khi `APPROVED` bắt buộc có `replacementMutationId`. |
| **`originalCreatedAt`** | `originalCreatedAt?: string` (ISO-8601 UTC) | `originalCreatedAtIso: String` (+ `originalCreatedAtMs: int` cache) | Bảo toàn timestamp gốc khi tạo pending trước khi bị quarantine; immutable qua mọi bước triage. |
| **`causalEvidence`** | `causalEvidence?: CausalTriageProof` | `causalEvidence: CausalTriageProof?` (SQLite `causal_evidence_json`) | Chứa snapshot/receipt evidence hoặc proof phê duyệt tạo mutation mới. |

5. **Bổ sung Quarantine Lifecycle Regressions (triển khai ở Web Step 5.2d & Mobile Stage 2):**
   - **`QT-01` (User Approval New Mutation):** Phê duyệt `q_old` (`mutId = old`, `baseRev = '10'`) → sinh `m_new` (`mutId != old`, `baseRev = currentServerRev`, đúng `effectiveEpoch`), `q_old.triageStatus = 'APPROVED'` chứa `replacementMutationId = m_new.mutationId`, `requeueQuarantinedMutation` cũ vẫn ném lỗi cấm requeue.
   - **`QT-02` (Crash Mid-Approval):** Giả lập lỗi / `tx.abort()` trước commit khi đang Approve → rollback 100%, `q_old` giữ nguyên `'PENDING'`, zero `m_new` mồ côi trong `pending_mutations`.
   - **`QT-03` (Push Retry & Idempotency of New Mutation):** `m_new` push gặp lỗi mạng tạm thời → retry giữ nguyên `m_new.mutationId` và `baseRev`, nhận `APPLIED` rồi `DEDUPLICATED`, không sinh thêm mutation mới, không sửa `q_old`.
   - **`QT-04` (GC Watermark Unblocked After `APPROVED`):** Tombstone `rev = 80`, `q_old` (`baseRev = '70'`) ở `'PENDING'` ghìm `safeGcFloor = '70'`; sau khi user chọn Approve (`q_old.triageStatus = 'APPROVED'`, `m_new` mang `baseRev = '100'`), chạy `gcAuthoritativeTombstones` → `safeGcFloor >= '80'` và xóa sạch tombstone `rev = 80` (chứng minh `'APPROVED'` không ghìm watermark vô hạn).

---

### 2.3 HMAC Cursor `mrev` & Xử Lý Signed Legacy v1 Cursor

1. **Cấu trúc HMAC Cursor:** `SnapshotCursorPayload = { v: 1, uid, srev, mrev?, domain, key, exp }`. Giữ `CURRENT_VERSION = 1` ở `HmacCursorHelper`.
2. **Validate `mrev` trong `HmacCursorHelper.verifyAndDecodeCursor`:**
   - Nếu chữ ký HMAC-SHA256 sai / payload không khớp chữ ký → `400 CURSOR_SIGNATURE_INVALID`.
   - Nếu `uid !== expectedUserId` → `400 CURSOR_ACCOUNT_MISMATCH`; `exp` quá hạn → `400 CURSOR_EXPIRED`; `v !== 1` → `400 CURSOR_VERSION_MISMATCH`.
   - Nếu `mrev !== undefined`: bắt buộc `typeof payload.mrev === 'string' && /^\d+$/.test(payload.mrev)` và `BigInt(payload.mrev) <= 9223372036854775807n` → vi phạm ném `400 CURSOR_INVALID_REVISION`.
3. **Signed legacy `v1` cursor thiếu `mrev` (`payload.mrev === undefined`):**
   - Khi một cursor `v1` có chữ ký HMAC hợp lệ nhưng thiếu `mrev` (phát sinh trước khi triển khai Patch Set B2) được gửi tới `GET /api/v1/sync/snapshot?cursor=...`:
   - `SyncService.getSnapshot` **FAIL-CLOSED + SAFE SNAPSHOT RESTART**: từ chối với **HTTP `409 Conflict`** (`code: 'SNAPSHOT_INVALIDATED'`, `reason: 'CURSOR_WATERMARK_UPGRADE_REQUIRED'`, kèm `currentServerRevision`, `minActiveRevision`). Client dọn `snapshot_staging_store` và khởi động lại từ Page 1 để nhận cursor `v1` mới đã pinned `mrev`.
4. **Bộ test HMAC Cursor `mrev` bắt buộc ở Patch Set B2:**
   - **`CUR-01`:** `mrev` âm (`'-1'`) → `400 CURSOR_INVALID_REVISION`.
   - **`CUR-02`:** `mrev` malformed (`'abc'`, `'1.5'`, `' 10 '`, numeric `10`) → `400 CURSOR_INVALID_REVISION`.
   - **`CUR-03`:** `mrev` overflow vượt PostgreSQL signed BIGINT max (`'9223372036854775808'`) → `400 CURSOR_INVALID_REVISION`.
   - **`CUR-04`:** Signature tampering (giải mã base64url, thay đổi `mrev: '0' -> '1'`, giữ signature cũ) → `400 CURSOR_SIGNATURE_INVALID`.
   - **`CUR-05`:** Signed legacy `v1` cursor thiếu `mrev` đưa vào `getSnapshot` → `409 SNAPSHOT_INVALIDATED`, client restart Page 1 an toàn.

---

### 2.4 Chuẩn Hóa `REG-17` (Fixture Revision `>= 13` & Domain-Boundary Cursor)

- **Server state hợp lệ:** `user_sync_state.current_sync_revision = '15'` (`>= 13`, tương xứng `sync_tombstones` tối đa rev `13` và thỏa `chk_sync_revision_monotonic`), `min_active_revision = '1'`.
- **Tổng số bản ghi giữ nguyên:** **11 DB rows**, **9 Wire items**, phân trang `limit = 2` thành **5 Pages** (`[2, 2, 2, 2, 1]`):
  - **DB Seed (11 rows):** `bookmarks(2: storyA, storyB)`, `reading_progress(0)`, `chapter_read_states(0)`, `user_preferences(1: 'theme:colon')`, `reading_history_tombstones(4: sentinel epoch=3, story1=1, story2=2, story3=4)`, `sync_tombstones(4 >= minActiveRev: ('HISTORY', sentinel, 11), ('HISTORY','all',11), ('PREFERENCE','pref:a:b',12), ('PREFERENCE','pref:a:c',13))`.
  - **Wire Output (9 items):** `globalHistoryEpoch: 3` trên mọi trang; `bookmarks` (2), `readingProgress` (0), `chapterReadStates` (0), `preferences` (1), `historyEpochs` (3 — không chứa sentinel), `tombstones` (3 — không chứa `'HISTORY:all'`).
  - **Kiểm chứng ranh giới domain (Exact Domain Boundaries):**
    - Page 1 (`limit = 2`): kết thúc **đúng ranh giới `BOOKMARK`** (bỏ qua `PROGRESS` & `CHAPTER_READ_STATE` rỗng) → `nextCursor = { domain: 'PREFERENCE', key: '', srev: '15', mrev: '1' }`.
    - Page 3 (`limit = 2`): kết thúc **đúng ranh giới `HISTORY_TOMBSTONE`** → `nextCursor = { domain: 'SYNC_TOMBSTONE', key: '', srev: '15', mrev: '1' }`.
    - Page 4 (`limit = 2`): tách giữa `'PREFERENCE':'pref:a:b'` và `'PREFERENCE':'pref:a:c'` → `nextCursor = { domain: 'SYNC_TOMBSTONE', key: '["PREFERENCE","pref:a:b"]', srev: '15', mrev: '1' }`.
    - Sub-case `limit = 3`: Page 1 (`bookmarks(2) + preferences(1) = 3`) kết thúc **đúng ranh giới cuối của `PREFERENCE`** → BẮT BUỘC `hasMore: true`, `nextCursor = { domain: 'HISTORY_TOMBSTONE', key: '', srev: '15', mrev: '1' }` (không ngắt sớm).

---

### 2.5 Bảo Lưu `REG-15`, `REG-18` & Taxonomy Lỗi `REG-03` / `REG-14`

- **`REG-15` (Giữ nguyên hiệu chỉnh v2.2):** Push `mutId = X` (`assignedRevision = '2'`) + push thêm 3 bookmarks (`currentServerRevision = '5'`), GC đặt `min_active_revision = 4` (`4 <= 5`) và xóa vật lý `sync_change_log < 4` trong khi giữ `sync_mutation_receipts`. `GET /sync/changes?after=0` trả `410 SYNC_REVISION_EXPIRED`; retry giống hệt `mutId = X` trả `200 DEDUPLICATED` (`assignedRevision: '2'`, `newServerRevision: '5'`); retry sửa payload trả `409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH`.
- **`REG-18` (Giữ nguyên hiệu chỉnh v2.2 — Snapshot Pagination vs Concurrent GC):** Seed `4` bookmarks + `1` tombstone `rev = 2` (`srev = '5'`, `mrev = '0'`). Page 1 (`limit = 2`) trả cursor gắn `mrev = '0'`. Chạy GC nâng `min_active_revision = 3` và xóa tombstone `< 3` trong khi `srev` giữ nguyên `'5'`. Request Page 2 với cursor Page 1 → **HTTP `409 SNAPSHOT_INVALIDATED`** (`minActiveRevision: '3'`, `cursorMinActiveRevision: '0'`).
- **Lỗi `REG-03` & `REG-14`:** HTTP DTO `ValidationPipe` trả `400 Bad Request` cho thiếu `observedHistoryEpoch` trên `HISTORY UPSERT`, số âm/thực, hoặc key dư; Causal Resolver trong `200 OK` batch trả `REJECTED_TOMBSTONE` theo thứ tự ưu tiên Guard 1 `TOMBSTONE_CONFLICT` (`baseRev < tombstoneRev`) → Guard 2 `MISSING_HISTORY_EPOCH_PROOF` (`PROGRESS` thiếu epoch khi `effectiveEpoch > 0`) / `STALE_HISTORY_EPOCH` (`observed < effective`) / `INVALID_HISTORY_EPOCH` (`observed > effective`).

---

## 3. Dependency DAG & Gate Control

`Patch Set A (PR hiện tại)` → `Merge PR #212 c440396 + Patch Set B1` → `Patch Set B2 (Dual-Delta + Snapshot + CUR-01..05 + REG-01..18)` → `Patch Set B3 (GC + REG-15/18)` → `{ Web Step 5.2d (QT-01..04 + Cold Bootstrap), Mobile Stage 2 (QT-01..04 + Cold Bootstrap) }`.

Mọi bước sau Patch Set A **đều bị khóa** cho đến khi Gate duyệt từng phase.
