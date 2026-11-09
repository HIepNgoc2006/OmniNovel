# 🏛️ OmniNovel Architecture Specification: Phase 7C.4 — Mobile Sync Reconciler (Storage Foundation & SQLite v5)

> **Tài liệu:** Kiến trúc Mobile Sync Reconciler — Storage Coexistence & SQLite Schema v5  
> **Trạng thái:** `STAGE 1 REMEDIATED / PENDING GATE REVIEW`  
> **Baseline tham chiếu:** `4a78f9c10f1ee0d891ba30cbeaaebe38343eac5f` (Hosted CI `#42053644100` — 7/7 PASS) + `4575760` (PR `#210` Security Remediation trên `main`, hợp nhất vào nhánh qua merge commit `67e3404`)  
> **Phạm vi Stage 1:** SQLite Schema Migration `v4 -> v5`, Mobile Sync Storage DAL, Checkpoint OCC (đa kết nối native SQLite), Durable Mutation FIFO (`sequence_no`), Quarantine full-fidelity & Snapshot Staging Metadata, Tombstone/Epoch Governance, Fail-Closed Baseline Lifecycle, ranh giới thẩm quyền Account Sync vs Guest-Local (`P0-M05`/`P0-M06`), fail-closed `readingMode` (`P1-M07`), và bền vững `clientId` (`P1-M08`).  
> **Các điều kiện bắt buộc từ Hội đồng Gate Review đã tích hợp:** **`P0-M01`**, **`P0-M02`**, **`P1-M03`**, **`P1-M04`**, và **Gate Review Remediation Round 1 (`P0-M05`, `P0-M06`, `P1-M07`, `P1-M08`)**.

---

## 1. Bối cảnh, Nguyên tắc & Ranh giới Đóng băng (Frozen Boundaries)

OmniNovel Mobile (`apps/mobile`, Flutter + SQLite/`sqflite`) đồng bộ đa thiết bị với Core API Sync Hub (`services/api`) theo cùng giao thức nhân quả của Phase 7C.0 (`GET /sync/changes`, `GET /sync/snapshot`, `POST /sync/mutations/batch`) và các bất biến lưu trữ của Web Phase 7C.3 Step 5.2a/5.2b, nhưng **thiết kế bản địa cho SQLite quan hệ + transaction `BEGIN IMMEDIATE`**, không sao chép máy móc mô hình IndexedDB sang SQLite.

### Ranh giới đóng băng bắt buộc (Strict Frozen Boundaries)
- **Tuyệt đối không chỉnh sửa:** `apps/web/**`, `services/api/**`, `packages/shared/**`, [`local_library_dao.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/storage/local_library_dao.dart), [`guest_claim_coordinator.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/claim/guest_claim_coordinator.dart), `apps/mobile/lib/core/identity/**`, `apps/mobile/lib/core/auth/**`, `.trivyignore`, `deploy/**`, `.github/**`.
- **Đồng bộ an toàn với Security Remediation (`PR #210`):** Nhánh `feat/7c4-mobile-sync` đã merge cleanly commit `4575760` (`PR #210`) từ `origin/main` (tại merge commit `67e3404`), giữ Draft PR [`#209`](https://github.com/HIepNgoc2006/OmniNovel/pull/209) chưa merge và tuyệt đối không ghi đè `.trivyignore` hay cấu hình CI.
- **Stage 1 chỉ xây dựng tầng nền tảng lưu trữ:** Không triển khai `Background SyncWorker`, không gọi mạng `/sync/*`, không bật Stage 2 Projection UI Adapter và **tuyệt đối không cấp trạng thái `READY`** cho baseline account.

---

## 2. Xác minh Schema SQLite Hiện Hành (`v4`) & Bảng Đồ Migration (`v4 -> v5`)

### 2.1 Kiểm kê 7 Bảng Hiện Hữu (Schema v4 — Bảo toàn 100% Additive)

Qua rà soát trực tiếp [`offline_database.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/storage/offline_database.dart) (`databaseVersion = 4`):

| Phiên bản | Tên bảng | Primary Key / Unique | Chức năng hiện hành | Chính sách `v4 -> v5` |
|---|---|---|---|---|
| `v2` | `offline_chapters` | `PK(user_id, chapter_version_id)` | SSoT gói chương offline trên đĩa | **Giữ nguyên 100%** (không `DROP`, không `ALTER`) |
| `v2` | `download_tasks` | `PK(task_id)`, `UNIQUE(user_id, chapter_version_id)` | Hàng đợi tải gói chương offline | **Giữ nguyên 100%** |
| `v2` | `offline_deletion_tombstones` | `PK(tombstone_id)`, `UNIQUE(user_id, chapter_version_id)` | Phục hồi xóa 3 bước offline | **Giữ nguyên 100%** |
| `v3` | `local_library_bookmarks` | `PK(owner_scope, story_id)` | Bookmark cục bộ (Guest + Account) | **Giữ nguyên 100%** |
| `v3` | `local_reading_progress` | `PK(owner_scope, story_id)` | Tiến độ đọc hiện tại 12 cột | **Giữ nguyên 100%** |
| `v3` | `local_reading_history` | `PK(owner_scope, story_id, chapter_id)` | Lịch sử chương monotonic MAX | **Giữ nguyên 100%** |
| `v4` | `guest_claim_recovery_journal` | `PK(claim_id)` | Sổ cái crash recovery Guest Claim | **Giữ nguyên 100%** |

### 2.2 Bảy Bảng Bổ Sung Ở Schema `v5` (Additive DDL)

Migration `v4 -> v5` nâng `OfflineDatabase.databaseVersion = 5`, bổ sung cấu hình connection an toàn trong `_onConfigure` và tạo mới 7 bảng sync cô lập:

```text
+-------------------------------+---------------------------------------------------+
| Bảng mới (v5)                 | Primary Key / Constraints / Indexes               |
+-------------------------------+---------------------------------------------------+
| sync_meta                     | PK(owner_scope)                                   |
|                               | CHECK baseline IN (UNINITIALIZED,BOOTSTRAPPING,READY)
| sync_mutation_sequences       | PK(owner_scope) [P1-M03 durable FIFO sequence]    |
| sync_authoritative_replicas   | PK(owner_scope, domain, entity_key)               |
|                               | IDX(owner_scope, domain), IDX(owner_scope, rev)   |
| pending_mutations             | PK(owner_scope, mutation_id)                      |
|                               | UNIQUE(owner_scope, sequence_no) [P1-M03]         |
|                               | IDX(owner_scope, sequence_no ASC)                 |
| quarantined_mutations         | PK(owner_scope, mutation_id) [P1-M04 full record] |
|                               | IDX(owner_scope, rejected_at_ms DESC)             |
| snapshot_staging_store        | PK(owner_scope, session_id, domain, entity_key)   |
|                               | IDX(owner_scope, session_id) [P1-M04 metadata]    |
| local_preferences             | PK(owner_scope, pref_key)                         |
+-------------------------------+---------------------------------------------------+
```

---

## 3. Đặc tả Chi Tiết Storage Model (Mục A) & Tích Hợp Điều Kiện `P0-M01 .. P1-M04`

### 3.1 Cấu hình SQLite Connection & Concurrency (`_onConfigure`)
- Kích hoạt `PRAGMA foreign_keys = ON;`.
- Thiết lập `await db.rawQuery('PRAGMA busy_timeout = 5000;');` để hai kết nối độc lập tranh chấp write lock không lỗi tức thời `SQLITE_BUSY` mà đợi nhả lock và kiểm tra OCC bên trong transaction.
- Bật Write-Ahead Logging an toàn **chỉ khi không chạy `:memory:`**: kiểm tra `db.path.isNotEmpty && !db.path.contains(':memory:')` rồi gọi `await db.rawQuery('PRAGMA journal_mode = WAL;');` bên trong `try/catch` (dùng `rawQuery` vì SQLite trả về một dòng kết quả `[{'journal_mode': 'wal'}]`, tránh lỗi Android `execute()` với PRAGMA trả dòng).

### 3.2 Revision Wire Safety (`64-bit BIGINT` Decimal String)
- Cả Server PostgreSQL (`BIGINT`) và protocol contract (`packages/shared`) truyền mọi `revision`, `lastSyncedServerRevision`, `minActiveRevision`, `nextRevision`, `baseServerRevision` dưới dạng **chuỗi thập phân** (`TEXT` trong SQLite, `BigInt` trong Dart).
- Strict validator `isValidRevisionString(val)`: khớp `RegExp(r'^(0|[1-9][0-9]*)$')` **hoặc** kiểm định phạm vi nguyên không âm chuẩn (`0 <= BigInt <= 9223372036854775807` đối với PostgreSQL signed 64-bit BIGINT, không số âm, không dấu chấm thập phân, không chữ cái, không khoảng trắng, không vượt trần signed BIGINT). Lưu ý chuỗi toàn `'0'` được chấp nhận (`'0'`), từ chối leading zeros như `'01'`/`'00'` hoặc chỉ chấp nhận canonical decimal integers để tránh lệch so sánh chuỗi/số. Thực tế so sánh luôn dùng `BigInt.parse(...)`.

### 3.3 Account Scope & Coexistence Model (`P0-M05` Authority Partitioning)
- **Tách biệt tuyệt đối ranh giới Account Sync vs Guest-Local ngay tại DAL (`P0-M05`):**
  - **Account Sync Storage (`account:<userId>`):** Toàn bộ thao tác đọc/ghi bảng sync (`sync_meta`, `sync_mutation_sequences`, `sync_authoritative_replicas`, `pending_mutations`, `quarantined_mutations`, `snapshot_staging_store`), các lệnh atomic local write + enqueue, `getAccountLocalPreference`/`getAllAccountLocalPreferences`, `applyAuthoritativeDeltaPage`, và `purgeAccountScope` đều **bắt buộc** đi qua `assertAccountScope(ownerScope)` và ném `InvalidSyncScopeException('ACCOUNT_SYNC_SCOPE_REQUIRED')` ngay tức thì nếu truyền `guest:*` hoặc scope sai định dạng.
  - **Guest-Local Storage (`guest:<guestProfileId>`):** Tiếp tục đọc/ghi tự do qua `local_library_*` (`LocalLibraryDao`) với 0 network calls. Các tùy chọn cục bộ và dọn dẹp vòng đời Guest được tách thành API tường minh (`putGuestLocalPreference`, `getGuestLocalPreference`, `getAllGuestLocalPreferences`, `deleteGuestLocalPreference`, `purgeGuestLocalScope`), cưỡng chế `assertGuestScope(guestScope)` (`GUEST_SCOPE_REQUIRED`) và chặn mọi `account:*`.
  - **Lifecycle-Protected Purge:**
    - `purgeAccountScope(ownerScope, reason: AccountPurgeReason, admission: AccountWriteAdmission)` chỉ xóa dữ liệu scope Account trong 10 bảng cục bộ/sync của riêng `account:<userId>`, bảo toàn `offline_*` và `guest_claim_recovery_journal`.
    - `purgeGuestLocalScope(guestScope, reason: GuestLifecyclePurgeReason, admission: GuestLocalWriteAdmission, guestProfileProvider)` **chặn fail-closed (`PurgeProhibitedError`)** trước và trong SQLite transaction nếu `guestProfileId` nằm trong danh sách cách ly (`listQuarantinedGuestScopes()`) **hoặc** còn bất kỳ dòng nào trong `guest_claim_recovery_journal` (mọi pha `prepared` / `committing` / `committedServer`). Khi an toàn, chỉ xóa 4 bảng `local_*` của riêng `guestScope`.
- Không ghi dữ liệu vào `local_*` từ `applyAuthoritativeDeltaPage`: Delta Ingestion chỉ ghi `sync_authoritative_replicas` + `sync_meta`, tuyệt đối giữ cô lập Tầng 1 (Shadow) và Tầng 2 (Pending) đúng kiến trúc Coexistence v2.2.

### 3.4 Điều kiện `P0-M01` — Delta Cursor Integrity & Server Contract Parity
`applyAuthoritativeDeltaPage()` thực thi kiểm định fail-closed nghiêm ngặt tương đương hoàn toàn Web Step 5.2b và Core API `/api/v1/sync/changes`:
1. **`expectedCheckpoint` bắt buộc:** Phải là non-null canonical decimal `String`; thiếu hoặc sai định dạng -> ném `InvalidDeltaPayloadError('MANDATORY_OCC_CHECKPOINT_REQUIRED: ...')`.
2. **Metadata trang bắt buộc:** `currentServerRevision`, `minActiveRevision` phải là decimal `String` hợp lệ.
3. **Pagination Cursor Integrity (`hasMore` vs `nextRevision` vs `changes`):**
   - Nếu `hasMore == true`:
     - `changes` không được rỗng (`INCONSISTENT_DELTA_PAGE: hasMore is true, but changes array is empty`).
     - `nextRevision` bắt buộc khác null và là decimal string hợp lệ.
     - `nextRevision == changes.last.revision` chính xác tuyệt đối (ngăn bỏ sót delta giữa cursor và change cuối, hoặc lặp vô hạn nếu cursor lùi sau change cuối).
   - Nếu `hasMore == false`:
     - `nextRevision` bắt buộc phải là `null` (`INCONSISTENT_DELTA_PAGE: hasMore is false, but nextRevision is not null`).
4. **Compacted Retention Gap Guard:**
   - Nếu `expectedCheckpoint != '0'` và `BigInt.parse(expectedCheckpoint) < BigInt.parse(page.minActiveRevision)` -> ném `InvalidDeltaPayloadError('COMPACTED_RETENTION_GAP: ...')` (báo hiệu bắt buộc 410 Snapshot Resync ở Stage 3).
5. **Target Checkpoint Boundary:**
   - `targetCheckpoint = page.hasMore ? page.nextRevision! : page.currentServerRevision`.
   - `BigInt.parse(targetCheckpoint) <= BigInt.parse(page.currentServerRevision)` (vượt trần server -> `INCONSISTENT_DELTA_PAGE`).
   - `BigInt.parse(targetCheckpoint) >= BigInt.parse(expectedCheckpoint)` (lùi checkpoint -> `REGRESSIVE_CHECKPOINT`).
6. **Item-Level Causal Revision Ordering:**
   - Với mọi phần tử `change` tại index `i`:
     - `rev > expectedCheckpoint` (`<=` là `INCONSISTENT_DELTA_PAGE` stale duplicate).
     - `rev <= targetCheckpoint` (`>` là `INCONSISTENT_DELTA_PAGE`).
     - `rev >= prevRev` trong cùng page (`<` là regressive ordering -> `InvalidDeltaPayloadError`).
     - Validate `domain`, `operation`, non-empty `entityId`.
     - Với `HISTORY + DELETE`: bắt buộc `payload['epoch']` là số nguyên dương (`> 0`), thiếu -> `MISSING_HISTORY_DELETE_EPOCH`.
7. **Atomic Rollback:** Khi bất kỳ lỗi nào xảy ra trước hoặc trong transaction, `sqlite` transaction rollback toàn bộ: `sync_authoritative_replicas` và `sync_meta` giữ nguyên 100%.

### 3.5 Điều kiện `P0-M02` & `P0-M06` — Native SQLite OCC & Mandatory 4-Barrier Authority Admission
- **OCC bên trong Native SQLite Transaction (Không phụ thuộc Dart Lock):**
  - Mọi đường ghi quan trọng (`applyAuthoritativeDeltaPage`, atomic write + enqueue, `recordTransientFailureAtomic`, `quarantinePendingMutationByKey`, `requeueQuarantinedMutation`, `putSyncMeta`, `setAuthoritativeBaselineStatus`, `purgeAccountScope`, `purgeGuestLocalScope`) đều chạy trong `db.transaction((txn) async { ... })` (`BEGIN IMMEDIATE` — serialized native SQLite write transaction).
  - Trong `applyAuthoritativeDeltaPage`: `last_synced_server_revision` được **đọc lại trực tiếp từ bảng `sync_meta` bằng `txn.query(...)` bên trong cùng native SQLite transaction** ngay trước khi ghi bất kỳ shadow row nào!
  - Nếu `expectedCheckpoint != storedCheckpoint`: ném `CheckpointConflictError('OCC_CHECKPOINT_MISMATCH: ...')`, làm transaction SQLite abort & rollback hoàn toàn.
  - **Không phụ thuộc Dart mutex riêng lẻ:** Dù hai kết nối SQLite (`OfflineDatabase`) hoàn toàn độc lập mở trên 2 OS thread riêng biệt (`Isolate.spawn` + `databaseFactoryFfiNoIsolate`) tới cùng tệp `.db` và ghi đồng thời cùng `expectedCheckpoint`, khóa ghi native SQLite + `busy_timeout` buộc connection thua đọc đúng `storedCheckpoint` đã nâng của người thắng bên trong transaction của mình và thất bại cleanly với `CheckpointConflictError` (không dirty write).
  - **Khả năng chịu lỗi `EINTR` / `SIGPROF` khi giành khóa `BEGIN IMMEDIATE` trên Linux:** Trên Linux (đặc biệt khi chạy Dart VM `--coverage` với `SIGPROF`), `nanosleep` bên trong `unixSleep` của SQLite C có thể bị signal ngắt (`EINTR`), khiến `PRAGMA busy_timeout` trả sớm `SQLITE_BUSY (5)`. Vì vậy `_runWriteTransaction` thực thi thêm vòng retry bất đồng bộ có giới hạn (`defaultBusyRetryTimeout = 5000ms` với backoff `10ms..50ms` qua `Future.delayed`) **chỉ khi**: (1) chưa bước vào thân callback `action(txn)` (`!enteredAction`), (2) lỗi đúng là `SQLITE_BUSY` (primary code `5`, phân biệt với `SQLITE_LOCKED (6)` và constraint), và (3) `admission.assertAdmitted(targetScope)` vẫn hợp lệ ở mỗi lần thử lại.
- **Loại bỏ hoàn toàn bypass tùy chọn & Cưỡng chế 4-Barrier `SyncWriteAdmission` (`P0-M06`):**
  - Loại bỏ 100% tham số nullable `void Function()? checkAdmission` khỏi [`SyncStorageDal`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart) và [`RecordTransientFailureOptions`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/models/sync_models.dart).
  - Bổ sung module [`sync_write_admission.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/authority/sync_write_admission.dart):
    - **`AccountWriteAdmission`** (bắt buộc non-null trên mọi thao tác ghi Account Sync): kiểm chứng 6 điều kiện từ `LiveSyncAuthoritySource` (đọc đồng thời cả `ActiveScopeCoordinator` lẫn `AuthService`): (1) `targetScope == 'account:$expectedUserId'`, (2) `AuthService.state.isAuthenticated == true` (tự động chặn `unauthenticated` và `pendingVerification`), (3) `AuthService.state.user?.id == expectedUserId`, (4) `ActiveScopeCoordinator.state == ActiveScopeState.account && canMutateUserState`, (5) `activeScope == 'account:$expectedUserId'`, (6) `transitionGeneration == expectedGeneration`.
    - **`GuestLocalWriteAdmission`** (bắt buộc non-null trên mọi thao tác ghi Guest-local preference và `purgeGuestLocalScope`): tách kiểu hoàn toàn với `AccountWriteAdmission` nên không thể dùng nhầm vào Account Sync DAL.
  - **4 Hàng rào Bảo vệ Đồng bộ trong `_runWriteTransaction`:**
    1. **Barrier 1 (Pre-acquisition):** Gọi `admission.assertAdmitted(targetScope)` **trước khi** chạm `asyncDatabaseProvider` hay `Database` handle.
    2. **Barrier 2 (Post-acquisition Pre-transaction):** Gọi `admission.assertAdmitted(targetScope)` ngay sau `await _acquireDatabase()`, **trước khi mở** `db.transaction(...)` (chặn phiên đã hết hạn trong lúc đợi DB acquire).
    3. **Barrier 3 (In-transaction Entry):** Gọi `admission.assertAdmitted(targetScope)` ngay khi vào thân `db.transaction`, trước mọi câu lệnh SQL mutate.
    4. **Barrier 4 (Pre-commit Seal):** Gọi `admission.assertAdmitted(targetScope)` lại ngay trước khi kết thúc callback transaction để SQLite commit (sau cả `onBeforeCommitHook`), bảo đảm logout / thu hồi phiên / đổi user / xoay `transitionGeneration` diễn ra giữa chừng đều gây rollback sạch 100%.

### 3.6 Điều kiện `P1-M03` — Durable Monotonic Mutation FIFO (`sequence_no`)
- **Bất biến FIFO không phụ thuộc đồng hồ thiết bị:**
  - `DateTime.now().millisecondsSinceEpoch` có thể trùng hệt nhau cho nhiều thao tác liên tiếp (hoặc giật lùi khi NTP điều chỉnh đồng hồ). Nếu chỉ `ORDER BY created_at_ms`, thứ tự gửi batch lên server sẽ bất định (non-deterministic), có thể đảo ngược cặp `PROGRESS Chap 1 -> Chap 2` hoặc `UPSERT -> DELETE`.
  - **Cơ chế SQLite Bền vững (`sync_mutation_sequences`):**
    1. Bảng `sync_mutation_sequences(owner_scope PRIMARY KEY, last_sequence_no INTEGER NOT NULL DEFAULT 0)`.
    2. Trong **cùng một SQLite write transaction** khi chèn một mutation vào `pending_mutations`:
       - `INSERT OR IGNORE INTO sync_mutation_sequences(owner_scope, last_sequence_no) VALUES (?, 0)`
       - `UPDATE sync_mutation_sequences SET last_sequence_no = last_sequence_no + 1 WHERE owner_scope = ?`
       - Đọc `SELECT last_sequence_no FROM sync_mutation_sequences WHERE owner_scope = ?`
       - Chèn row vào `pending_mutations` với `sequence_no = last_sequence_no`.
    3. Ràng buộc bảng `pending_mutations` có `UNIQUE(owner_scope, sequence_no)` và index `idx_pending_mutations_scope_fifo ON pending_mutations(owner_scope, sequence_no ASC)`.
    4. `getPendingMutations(ownerScope)` truy vấn `ORDER BY sequence_no ASC`.
    5. Khi toàn bộ `pending_mutations` được flush sạch (rỗng) hoặc app khởi động lại sau crash, `last_sequence_no` vẫn được bảo tồn bền vững trong SQLite nên không bị reset về 1 hay trùng khóa FIFO; nếu transaction enqueue thất bại (ví dụ `mutation_id` trùng lặp với `ConflictAlgorithm.abort`, `admission.assertAdmitted` throw, hoặc local write rollback), `UPDATE sync_mutation_sequences` cũng **rollback nguyên tử** theo transaction.

### 3.7 Điều kiện `P1-M04` — Snapshot Staging Metadata & Full-Fidelity Quarantine Preservation
- **Quarantine Preservation (`quarantined_mutations`):**
  - Khi chuyển mutation từ `pending_mutations` sang `quarantined_mutations` (qua `recordTransientFailureAtomic` khi chạm `maxRetries` hoặc `quarantinePendingMutationByKey`), hệ thống chuyển trong 1 transaction duy nhất và **bảo toàn 100% metadata nguyên bản**:
    - `owner_scope`, `mutation_id`, `client_id`, `domain`, `entity_id`, `operation`, `base_server_revision`, `observed_history_epoch`, `payload_json`, `original_sequence_no`, `original_retry_count`, `original_created_at_iso`, `original_created_at_ms`.
  - Bổ sung đầy đủ quarantine triage metadata: `rejection_reason`, `rejection_status`, `rejected_at_iso`, `rejected_at_ms`, `triage_status` (`PENDING` mặc định), `causal_evidence_json`.
  - Khóa requeue an toàn (`requeueQuarantinedMutation`):
    - Cấm tuyệt đối requeue `REJECTED_TOMBSTONE` (chống phục sinh vĩnh viễn).
    - Khóa `REJECTED_STALE` và `HTTP_410_GONE` cho tới khi Stage 3 Causal Triage Engine hoàn thiện (ném error rõ ràng `REQUEUE_PROHIBITED`).
    - Khi requeue hợp lệ (ví dụ `EXCEEDED_MAX_RETRIES` / `MANUAL`), reset `retry_count = 0`, `next_retry_at_ms = NULL`, khôi phục `original_created_at_*` & `observed_history_epoch`, cấp lại `original_sequence_no` (nếu có và an toàn duy nhất nhờ chuỗi đơn điệu `sync_mutation_sequences`) hoặc xin `sequence_no` mới nếu chưa có, chèn với `ConflictAlgorithm.abort`.
- **Snapshot Staging Store (`snapshot_staging_store` — Không đóng băng sớm Stage 3):**
  - Stage 1 provisioning đủ metadata để kiểm chứng tính nhất quán session phân trang snapshot theo `packages/shared` DTO (`SyncSnapshotResponse`):
    - `owner_scope`, `session_id`, `snapshot_revision`, `min_active_revision`, `cursor_token`, `page_index`, `domain`, `entity_key`, `payload_json`, `staged_at_iso`, `staged_at_ms`.
    - `stageSnapshotItems(...)` bảo vệ invariant đơn nhất phiên: mọi trang ghi vào cùng `(owner_scope, session_id)` bắt buộc phải mang cùng một `snapshot_revision` (nếu phát hiện lệch revision trong cùng `session_id`, lập tức từ chối và giữ staging sạch sẽ hoặc yêu cầu clear session trước khi restart trang 1 sau `409 SNAPSHOT_INVALIDATED`).
  - **Không đóng băng sớm schema Stage 3:** Metadata bổ sung cho Global Epoch khi danh sách `chapterReadStates` rỗng (**Mismatch M1**) được hoãn tới Stage 3 sau khi Backend remediation cho `GET /sync/snapshot` được phê duyệt (có thể mở rộng bằng bảng header `snapshot_staging_sessions` ở SQLite `v6` nếu cần).

### 3.8 Điều kiện `P1-M07` & `P1-M08` — Fail-Closed `readingMode` & Bền vững `clientId`
- **`P1-M07` — Fail-Closed `normalizeSyncReadingMode` (Không fallback ngầm `'WEBTOON'`):**
  - [`normalizeSyncReadingMode`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/utils/canonical_entity_key.dart#L120-L132) chỉ chấp nhận tập canonical `'WEBTOON' | 'PAGED' | 'NOVEL'` và legacy alias `'MANGA_PAGED' -> 'PAGED'`.
  - Mọi giá trị `null`, rỗng, ngoài tập hợp (hoặc sai kiểu) đều ném `InvalidSyncReadingModeException('INVALID_SYNC_READING_MODE')` tại tất cả các điểm nhập: `normalizeSyncReadingMode`, `buildSyncProgressPayload`, `recordReadingSessionWithMutation`, `enqueuePendingMutation`, `applyAuthoritativeDeltaPage` (item `PROGRESS`), và `stageSnapshotItems` (item `PROGRESS`).
- **`P1-M08` — Durable `clientId` Identity & Separation (KISS / Zero Extra SQLite Columns):**
  - [`SyncClientIdentityProvider`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/authority/sync_client_identity_provider.dart) tái sử dụng trực tiếp nguồn SSoT [`InstallationIdentityProvider`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/identity/installation_identity_provider.dart) (`omninovel_installation_id` trong `FlutterSecureStorage` + fallback `SharedPreferences`), **không thêm cột `client_id` dư thừa vào bảng `sync_meta`**.
  - Bền vững qua khởi động lại ứng dụng, đóng/mở lại SQLite DB, `ActiveScopeCoordinator.onLogout()`, `PreferencesService.clearPreferences()`, và đổi tài khoản (`user-A -> user-B`).
  - Kiểm định fail-closed chuẩn RFC4122 UUIDv4 (`isValidUuidV4`) và cấm trùng lặp với `userId`, `guestProfileId`, hoặc JWT `sessionId` (`sid`/`sessionId` claim) tại cả `SyncClientIdentityProvider` lẫn `SyncStorageDal` (`enqueuePendingMutation`, `recordReadingSessionWithMutation`, `quarantineMutation`, v.v. -> `InvalidClientIdentityException`).

---

## 4. Tombstone Safety & Effective History Epoch (Mục C)

- **Key chuẩn hóa:**
  - Global Sentinel UUID: `'00000000-0000-0000-0000-000000000000'` (và alias `'all'` khi chuẩn hóa đầu vào).
  - Bookmark Shadow Key: `storyId`.
  - Progress Shadow Key: `storyId`.
  - History Shadow Key: `'$storyId:$chapterId'` (chuẩn hóa dù `change.entityId` truyền `'story:chap'` hay payload chứa `storyId` + `chapterId`).
  - Preference Shadow Key: `key`.
- **Tính toán Effective Epoch:**
  $$\text{effectiveEpoch}(\text{storyId}) = \max\Big(\text{effectiveHistoryEpochs}[\text{storyId}] \;\text{??}\; 0,\; \text{effectiveHistoryEpochs}[\text{GLOBAL\_SENTINEL}] \;\text{??}\; 0\Big)$$
- **Strict Monotonicity Guard khi `applyAuthoritativeDeltaPage` xử lý `HISTORY DELETE`:**
  1. Bắt buộc `payload['epoch']` là `int > 0` (`MISSING_HISTORY_DELETE_EPOCH`).
  2. **Global `HISTORY DELETE`** (`entityId == GLOBAL_SENTINEL || entityId == 'all'`):
     - Yêu cầu `newEpoch > currentGlobalEpoch`, ngược lại ném `NonMonotonicHistoryEpochError` (`NON_MONOTONIC_HISTORY_EPOCH`) & rollback.
     - Cập nhật `effectiveEpochs[GLOBAL_SENTINEL] = newEpoch`.
     - Cascade DELETE **toàn bộ** `sync_authoritative_replicas` của `owner_scope` với `domain IN ('HISTORY', 'PROGRESS')`. Bảo toàn 100% `BOOKMARK`, `PREFERENCE`, `FOLLOW`.
  3. **Story-wide `HISTORY DELETE`** (`storyId`):
     - Yêu cầu `newEpoch > max(currentStoryEpoch, currentGlobalEpoch)` (đảm bảo **Global Epoch Dominance**), ngược lại ném `NonMonotonicHistoryEpochError` & rollback.
     - Cập nhật `effectiveEpochs[storyId] = newEpoch`.
     - Cascade DELETE mọi shadow `HISTORY` của `storyId` (`entity_key = storyId OR entity_key LIKE '${storyId}:%'` escaped `LIKE` wildcard an toàn!) và shadow `PROGRESS` có `entity_key = storyId`. Bảo toàn 100% các truyện khác và domain `BOOKMARK`/`PREFERENCE`.
- **Anti-Resurrection Eviction (`evictReplicaAndRemovePending`):**
  - Khi mutation bị từ chối tombstone (`REJECTED_TOMBSTONE`) hoặc bị loại trong causal triage: xóa bản ghi local liên quan + xóa `pending_mutations` nguyên tử trong **cùng 1 SQLite transaction** (và cascade xóa cả progress + chapter history với `HISTORY`).
- **Zero Client Wall-Clock Authority:** Tuyệt đối không dùng `DateTime.now()` hoặc `created_at_ms` để quyết định thắng/thua dữ liệu đồng bộ.

---

## 5. Baseline Lifecycle Fail-Closed (Mục D)

```text
   [No sync_meta row / Upgrade v4->v5 / Checkpoint '0' / Checkpoint > '0']
                                 │
                                 ▼
                         UNINITIALIZED  (isAuthoritativeReady == false)
                                 │
        setAuthoritativeBaselineStatus('BOOTSTRAPPING')
                                 │
                                 ▼
                         BOOTSTRAPPING  (isAuthoritativeReady == false)
                        ╱               ╲
      Crash/Reopen     ╱                 ╲  [Stage 3 Verified Snapshot Finalizer
   recoverInterrupted ╱                   ╲  WITH Backend M1 Proof ONLY — LOCKED IN STAGE 1]
                     ▼                     ▼
               UNINITIALIZED             READY
```

### Quy tắc khóa trong Stage 1
1. Mọi scope mới (`rev == '0'`) hay scope đã nâng cấp từ v4 đều mặc định `authoritativeBaselineStatus = UNINITIALIZED`, `isAuthoritativeReady(scope) == false`.
2. `setAuthoritativeBaselineStatus(scope, READY)` bị **chặn tuyệt đối** và ném `ReadyStatusTransitionForbiddenError`.
3. `putSyncMeta(meta)` **chặn kép**:
   - Cấm nâng cấp từ non-`READY` lên `READY` (`ReadyStatusTransitionForbiddenError`).
   - Nếu scope đã ở trạng thái `READY`: **cấm sửa đổi** `lastSyncedServerRevision`, `minActiveRevision`, và `effectiveHistoryEpochs` qua `putSyncMeta` (`CHECKPOINT_MUTATION_FORBIDDEN`); chỉ cho phép cập nhật các trường vận hành như `syncState`, `lastSyncTimestamp`, `lastErrorMessage`.
4. `applyAuthoritativeDeltaPage()` cập nhật checkpoint và epochs nhưng **bảo toàn nguyên trạng** `UNINITIALIZED` / `BOOTSTRAPPING` (không tự cấp `READY`).
5. `recoverInterruptedBootstrapToUninitialized(scope)` đưa scope bị crash giữa `BOOTSTRAPPING` quay về `UNINITIALIZED` khi khởi động lại.
6. Không tồn tại bất kỳ test backdoor / unsafe setter nào trong production DAL (`lib/`).

---

## 6. Khả Năng Tương Thích (Mục E) & Rà Soát Hợp Đồng (Contract Mismatches `M1..M5`)

### 6.1 Ma trận Tương thích Hệ sinh thái Mobile
| Thành phần hiện hữu | Cơ chế tương thích trong Stage 1 |
|---|---|
| **Existing Mobile Guest Library (`local_library_*`, `LocalLibraryDao`)** | 7 bảng v4 giữ nguyên schema/index. Guest (`guest:<id>`) tiếp tục hoạt động qua `LocalLibraryDao` với 0 thay đổi breaking và 0 network calls. |
| **Phase 7B Guest-to-Account Claim (`GuestClaimCoordinator`, `guest_claim_recovery_journal`)** | `guest_claim_recovery_journal` giữ nguyên 9 cột. `LocalLibraryDao.rebindScope()` giữ nguyên contract frozen. `purgeAccountScope` chỉ dọn scope `account:*`; `purgeGuestLocalScope` **chặn fail-closed (`PurgeProhibitedError`)** mọi Guest đang bị cách ly hoặc còn bất kỳ bản ghi `guest_claim_recovery_journal` nào. |
| **Reading Progress (`12 cột`, `readingMode`, `pageIndex >= 1`, `anchorBlockId`, `textOffset`)** | `normalizeSyncReadingMode` ánh xạ `MANGA_PAGED -> PAGED` và **fail-closed (`InvalidSyncReadingModeException`)** mọi giá trị `null`/rỗng/lạ (`P1-M07`), không fallback ngầm `'WEBTOON'`. |
| **Chapter Read State (`threshold >= 80%`)** | Bảo toàn toàn vẹn cột `progress_percentage` monotonic MAX trên `local_reading_history` và `maxProgressPercentage` trong payload `HISTORY`. |
| **Offline Storage Quota / LRU (`offline_chapters`, `download_tasks`, `offline_deletion_tombstones`)** | Cô lập hoàn toàn: `purgeAccountScope` / `purgeGuestLocalScope` / tombstone `HISTORY DELETE` chỉ xóa sync/reading metadata, không xóa gói chương offline đã tải hoặc pinned trên đĩa. Xóa hoàn toàn tài khoản ở Stage 4 sẽ kết hợp tuần tự `purgeAccountScope` + dọn thư mục `OfflineStoragePaths`. |

### 6.2 Danh sách Contract Mismatches đã kiểm định (Không tự sửa Backend/Shared ở Stage 1)
| Mã | Mô tả chênh lệch hợp đồng | Mức độ / Ảnh hưởng | Hướng xử lý |
|---|---|---|---|
| **`M1`** | `GET /api/v1/sync/snapshot` trả `chapterReadStates[].storyHistoryEpoch` nhưng chưa có `effectiveHistoryEpochs` toàn cục khi account có global tombstone và danh sách `chapterReadStates` rỗng. | **P0 Blocker cho Stage 3 Verified Bootstrap** (**Không block Stage 1 Storage Foundation**) | Giữ nguyên DTO Backend; ghi nhận defer đến Stage 3 + Backend snapshot remediation trước khi bật chuyển `READY`. |
| **`M2`** | `LocalReadingProgress` Mobile (`v3`) chấp nhận `readingMode = 'MANGA_PAGED'`, trong khi Canonical Sync DTO chỉ nhận `'WEBTOON' \| 'PAGED' \| 'NOVEL'`. | P1 Normalization (`P1-M07` fail-closed) | Chuẩn hóa ánh xạ `MANGA_PAGED -> PAGED` tại helper Sync payload (`normalizeSyncReadingMode`) và từ chối fail-closed mọi giá trị ngoài chuẩn; giữ nguyên `LocalLibraryDao` v3. |
| **`M3`** | `local_library_bookmarks` / `local_reading_history` v3 lưu trường UI (`title`, `slug`, `cover_url`, `chapter_number`, `chapter_title`), Sync protocol chỉ đồng bộ ID/metrics. | P1 Projection Hydration | Shadow (`sync_authoritative_replicas`) lưu canonical payload server; UI fields lấy từ local cache/catalog hydration (Stage 2). |
| **`M4`** | `HISTORY DELETE` global dùng `00000000-0000-0000-0000-000000000000` (backend emits UUID sentinel, accepts `'all'`). | Parity Locked | Mobile `canonical_entity_key.dart` nhận diện cả `'all'` và UUID sentinel, chuẩn hóa dùng `'00000000-0000-0000-0000-000000000000'`. |
| **`M5`** | `pending_mutations.sequence_no` không truyền qua Wire DTO `ClientMutation` (Wire chỉ có `mutationId`, `baseServerRevision`, `clientCreatedAt`). | Local Guarantee Only | `sequence_no` (`P1-M03`) dùng nội bộ SQLite để bảo đảm thứ tự FIFO tuyệt đối khi lấy batch gửi lên server. |

---

## 7. Ma trận Kiểm thử Bắt buộc Stage 1

| Nhóm kiểm thử | Tệp test | Các kịch bản trọng tâm |
|---|---|---|
| **SQLite v5 Migration & Preservations** | [`offline_database_v5_migration_test.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/storage/offline_database_v5_migration_test.dart) | Fresh v5 DDL (đủ 14 bảng + indexes + constraints), upgrade v3->v5 & v4->v5 bảo toàn 100% 7 bảng cũ (`offline_*`, `local_*`, `guest_claim_recovery_journal`), an toàn `PRAGMA busy_timeout` & `WAL` trên file DB vs `:memory:`. |
| **Atomic Local Write, Enqueue FIFO & Quarantine** | [`sync_storage_dal_test.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/sync/sync_storage_dal_test.dart) | `P1-M03` FIFO với cùng `created_at_ms` & qua close/reopen & khi queue từng drain rỗng; duplicate `mutation_id` `ConflictAlgorithm.abort` rollback toàn vẹn (local + sequence + pending); `onBeforeCommitHook` rollback; `recordTransientFailureAtomic` retry/backoff & `P1-M04` full-fidelity quarantine; cấm requeue `REJECTED_TOMBSTONE` / `REJECTED_STALE` / `HTTP_410_GONE`; `evictReplicaAndRemovePending`; `snapshot_staging_store` session/revision consistency; `purgeAccountScope` giữ nguyên offline chapters, quarantined guest scope & journal. |
| **Authoritative Delta, OCC Multi-Connection & Tombstones** | [`sync_delta_occ_tombstone_test.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/sync/sync_delta_occ_tombstone_test.dart) | `P0-M01` đủ mọi cursor edge case (`hasMore`, `nextRevision`, `changes`, `minActiveRevision` compacted gap, `targetCheckpoint > currentServerRevision`, regressive item/checkpoint, `BigInt > 2^53`); `P0-M02` OCC race giữa **2 kết nối SQLite (`OfflineDatabase`) độc lập** trên cùng file DB (winner tiến checkpoint, loser ném `CheckpointConflictError`, zero dirty shadow) + kiểm định deterministic pre-entry `SQLITE_BUSY` retry, cấm retry post-entry/`SQLITE_LOCKED (6)`/constraint, timeout fail-closed và `AccountWriteAdmission` mid-wait abort; `HISTORY DELETE` story-wide & global (`all` + UUID sentinel) cascade delete + strict monotonic epoch & global dominance & intra-page check + `LIKE` wildcard safety (`story_1` vs `story-1`). |
| **Scope Isolation, Baseline Lifecycle & Crash Recovery** | [`sync_scope_isolation_crash_test.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/sync/sync_scope_isolation_crash_test.dart) | Default `UNINITIALIZED` (rev 0 & migrated), fail-closed `isAuthoritativeReady == false`, chặn `READY` trực tiếp & via `putSyncMeta`, khóa bất biến checkpoint/epochs trên READY scope, phục hồi crash `BOOTSTRAPPING -> UNINITIALIZED` qua DB reopen, 4-barrier `AccountWriteAdmission` abort trước & cuối transaction (zero dirty state), cô lập hoàn toàn `guest:*` vs `account:A` vs `account:B` và chặn `getSyncMeta(guestScope)`. |
| **Gate Remediation Authority, Guest Boundaries, Fail-Closed Modes & ClientId** | [`sync_authority_remediation_test.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/sync/sync_authority_remediation_test.dart) & [`sync_test_helpers.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/sync/sync_test_helpers.dart) | **`P0-M05`:** Chặn `guest:*` trên toàn bộ Account Sync API (`InvalidSyncScopeException`), tách biệt Guest-local preferences, `purgeGuestLocalScope` chặn fail-closed (`PurgeProhibitedError`) đối với quarantined guest & `guest_claim_recovery_journal` (`prepared`/`committing`/`committedServer`); **`P0-M06`:** Kiểm định `LiveSyncAuthoritySource` thực tế với `ActiveScopeCoordinator` + `AuthService` + `AuthScopeBridge` (`transitioning`, `pendingVerification`, logout, cross-user, stale generation), Barrier 2 chặn sau async `asyncDatabaseProvider` delay với `transactionCalls == 0`, Barrier 4 rollback khi logout giữa transaction; **`P1-M07`:** `InvalidSyncReadingModeException` trên mọi điểm nhập (`normalizeSyncReadingMode`, `buildSyncProgressPayload`, `recordReadingSessionWithMutation`, `enqueuePendingMutation`, `applyAuthoritativeDeltaPage`, `stageSnapshotItems`); **`P1-M08`:** `SyncClientIdentityProvider` tái sử dụng `InstallationIdentityProvider`, không thêm cột vào `sync_meta`, bền vững qua `onLogout()`, `clearPreferences()`, DB reopen, đổi user, từ chối non-UUIDv4 và trùng lặp `userId` / `guestProfileId` / JWT `sid`. |
| **Regression 7A/7B & Full Mobile Suite** | Existing tests + `flutter analyze` | `flutter analyze --no-pub` 0 issues; toàn bộ test 7A/7B (`local_library_dao*`, `guest_claim*`, `active_scope_coordinator*`, `anti_resurrection_race*`, `guest_identity_isolation*`) + full suite PASS 100%. |

---

## 8. Lộ trình Các Giai Đoạn Tiếp Theo (Chỉ mở sau Gate Review)
- **Stage 1 (Đã khắc phục theo Gate Review — Đang chờ Gate Review tái nghiệm thu):** SQLite v5, Mobile Sync Storage DAL & Authority Remediation (`P0-M05`..`P1-M08`) — chờ Hội đồng Gate Review nghiệm thu `CLOSED / FROZEN CLEAN`.
- **Stage 2:** Pure Deterministic Causal Projection Engine (Dart) & Degraded Compatibility Adapter Switching.
- **Stage 3:** Delta Pull Reconciler, Background SyncWorker & Verified Snapshot Bootstrap (giải quyết `M1` trước khi cho phép chuyển `READY`).
- **Stage 4:** Cross-platform `SYNC-01..SYNC-20` Acceptance & Account Deletion Disk/DB Purge.

---

## 9. Bằng chứng Kiểm chứng & Danh mục Tệp Stage 1 (Sau Remediation Round 1)

- **Phân tích tĩnh:** `flutter --no-version-check --suppress-analytics analyze --no-pub` -> `No issues found! (ran in 4.7s)`.
- **Bộ test chuyên biệt Stage 1 & Remediation (`offline_database_v5_migration_test.dart` + `test/core/sync/`, 5 tệp test):** **38/38 PASS** (`flutter test --no-pub`), bao gồm tranh chấp OCC trên 2 OS thread SQLite độc lập qua `Isolate.spawn` + `databaseFactoryFfiNoIsolate`, `SQLITE_BUSY` retry guards, và toàn bộ bộ test authority remediation (`P0-M05`, `P0-M06`, `P1-M07`, `P1-M08`).
- **Bộ test hồi quy Phase 7A/7B (Migration v3/v4, `LocalLibraryDao`, Claim Flow, ActiveScope, Identity, Auth, Library, Reader Adapters, Router Acceptance):** **196/196 PASS**.
- **Toàn bộ Mobile Test Suite (81 tệp test):** **538/538 PASS** (`exit code 0`, 0 failures, 0 skipped).
- **Ranh giới đóng băng (`git diff origin/main...`):** Chỉ thay đổi trong `apps/mobile/**` và [`phase_07c_4_mobile_sync_architecture.md`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/plans/phase_07c_4_mobile_sync_architecture.md); hoàn toàn không chạm `apps/web/**`, `services/api/**`, `packages/shared/**`, `apps/mobile/lib/core/storage/local_library_dao.dart`, `apps/mobile/lib/core/claim/guest_claim_coordinator.dart`, `apps/mobile/lib/core/identity/**`, `apps/mobile/lib/core/auth/**`, `.trivyignore`, `deploy/**`, `.github/**`.
