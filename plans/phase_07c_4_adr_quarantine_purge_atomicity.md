# 🏛️ ADR-07C4-001: Architecture Decision Proposal — Guest Quarantine/Purge Atomicity (SQLite v6 SSoT) & Purge/DI Safety Audit

> **Mã tài liệu:** `ADR-07C4-001`  
> **Thuộc Phase:** OmniNovel Mobile Sync Engine — Phase 7C.4 Stage 1  
> **Trạng thái ADR:** `PROPOSED — PENDING GATE APPROVAL`  
> **Trạng thái Stage 1:** **`PENDING GATE REVIEW`** *(Chưa cấp `READY`, chưa cấp `FROZEN CLEAN`, PR [`#209`](https://github.com/HIepNgoc2006/OmniNovel/pull/209) giữ nguyên Draft)*  
> **Baseline mã nguồn kiểm định:** `a17495aa117c11009ddd81e97ce4e6c8dc5463db` trên nhánh `feat/7c4-mobile-sync` (Hosted CI `#42585874049`: `6 SUCCESS + 1 SKIPPED`)  
> **Tính chất thực thi:** **Tài liệu Audit & Architecture Decision Proposal.** Chưa chỉnh sửa bất kỳ frozen module nào, giữ nguyên [`OfflineDatabase.databaseVersion = 5`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/storage/offline_database.dart#L8), chưa can thiệp runtime code.

---

## 1. Tóm tắt Điều hành (Executive Summary)

Qua rà soát trực tiếp toàn bộ mã nguồn Stage 1 tại commit `a17495a`, kiến trúc hiện hành đã giải quyết tốt OCC đa kết nối (`P0-M02`), 4 hàng rào admission (`P0-M06`), FIFO bền vững (`P1-M03`), reading mode fail-closed (`P1-M07`), và chống giả mạo `clientId` khi dùng `SyncStorageDal.bound(...)` (`P1-M08`). Tuy nhiên, cuộc kiểm toán phát hiện **3 điểm rủi ro cấp `P0`/`P1`** cần Hội đồng Gate Review phê duyệt phương án xử lý trước khi đóng băng Stage 1 hoặc tiến sang Stage 2:

1. **`P0` — Guest Quarantine / Purge Cross-Store Atomicity Gap:** Cờ cách ly Guest hiện nằm trong `SharedPreferences` ([`GuestProfileIdentityProvider`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/identity/guest_profile_identity_provider.dart#L4-L67)), tách rời khỏi SQLite WAL/`BEGIN IMMEDIATE` của `guest_claim_recovery_journal` và 4 bảng `local_*`. Kiến trúc kiến nghị chuyển SSoT sang bảng SQLite v6 **`guest_quarantined_scopes`** (**Option A**).
2. **`P0/P1` — `AccountPurgeReason.signOutReset` Xóa Không Điều Kiện Pending/Quarantined Mutations:** [`SyncStorageDal.purgeAccountScope`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart#L2393-L2420) xóa sạch `pending_mutations` và `quarantined_mutations` ngay cả khi chưa đồng bộ hoặc chưa được người dùng xác nhận (trái ngược với `evictDetachedAccountScope`).
3. **`P0` — `GuestLifecyclePurgeReason.verifiedUnusedGuestEviction` Chấp nhận Nhầm `GuestLocalWriteAdmission`:** Tại [`SyncStorageDal.purgeGuestLocalScope`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart#L2538-L2568), nếu caller truyền `GuestLocalWriteAdmission` (admission của **Active Guest**) kèm `reason: verifiedUnusedGuestEviction`, nhánh kiểm tra active guest ở dòng `2556` bị bỏ qua hoàn toàn, cho phép xóa dữ liệu Active Guest.

---

## 2. Architecture Decision cho P0 Guest Quarantine / Purge Atomicity (Hạng mục 1 & 2)

### 2.1 Bằng chứng Lỗ hổng Kiến trúc Hiện hành (Dual-Store Boundary)

Kiểm tra trực tiếp mã nguồn tại `a17495a` xác nhận các điểm gãy bất đồng bộ giữa hai hệ lưu trữ:

1. **Quarantine lưu ngoài SQLite:** [`GuestProfileIdentityProvider.quarantineGuestScope`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/identity/guest_profile_identity_provider.dart#L52-L60) đọc/ghi key `'omninovel_quarantined_guest_profiles'` trong `SharedPreferences` (XML/plist trên đĩa + cache RAM per-isolate).
2. **`skipClaim()` tách 2 bước rời rạc (Non-Atomic Handoff):** Tại [`GuestClaimCoordinator.skipClaim`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/claim/guest_claim_coordinator.dart#L560-L571):
   - Bước 1 (dòng `562`): `await _guestProvider.quarantineGuestScope(guestProfileId);` ghi vào `SharedPreferences`.
   - Bước 2 (dòng `566-570`): `await _offlineDb.database.delete('guest_claim_recovery_journal', ...);` xóa sổ cái claim trong SQLite.
   - Nếu process crash giữa 2 dòng này, hệ thống rơi vào trạng thái lai (vừa có quarantine flag vừa còn journal `prepared`); nếu đảo thứ tự xóa journal trước khi ghi `SharedPreferences`, sẽ xuất hiện cửa sổ không còn journal mà cũng chưa có quarantine.
3. **Khe hở Post-Callback COMMIT trong `purgeGuestLocalScope()`:** Mặc dù [`SyncStorageDal.purgeGuestLocalScope`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart#L2547-L2619) đã thực hiện kiểm tra 3 lớp (pre-tx, in-tx pre-delete, và Barrier 4 trước khi trả về `txn` callback), nhưng trong `sqflite`, khi callback Dart kết thúc tại dòng `148-150` (`_runWriteTransaction`), `sqflite` phải gửi lệnh `COMMIT` bất đồng bộ qua platform-channel/FFI tới native SQLite engine. Trong khoảng thời gian hậu-callback đó, một isolate khác hoặc microtask gọi `quarantineGuestScope()` vẫn ghi thành công vào `SharedPreferences` mà SQLite `BEGIN IMMEDIATE` không hề hay biết để hủy `COMMIT`.

### 2.2 Đánh giá So sánh Các Phương án Kiến trúc

| Tiêu chí Đánh giá | **Option A (KHUYẾN NGHỊ): SQLite v6 `guest_quarantined_scopes` SSoT** | **Option B: Pure Dart Serialization / Lifecycle Mutex (giữ `SharedPreferences`)** | **Option C: Dual-Write / Two-Phase Coordinator trên 2 Store** |
|---|---|---|---|
| **Triệt tiêu Post-Callback COMMIT Race** | **Có — 100% nguyên tử tại SQLite Engine.** Khóa ghi SQLite giữ từ lúc mutate tới khi `COMMIT` vật lý hoàn tất. | **Không.** Vẫn tồn tại khe hở cross-isolate hoặc caller không dùng chung mutex. | **Không hoàn toàn.** Không có 2PC coordinator chuẩn trên XML `SharedPreferences`. |
| **Bảo vệ Multi-Isolate / Background Worker** | **Có.** Thực thi bằng WAL + file lock + `PRAGMA busy_timeout = 5000` ở cấp OS/SQLite. | **Không.** Mutex/Completer trong Dart chỉ có hiệu lực trong bộ nhớ 1 isolate duy nhất. | **Không.** `SharedPreferences` cache RAM khác nhau giữa các isolate. |
| **Crash Atomicity cho `skipClaim()`** | **Có.** Insert quarantine + Delete journal chạy chung 1 SQLite transaction -> cả hai cùng thắng hoặc cùng rollback. | **Không.** Crash giữa `prefs.setStringList` và `sqlite.delete` vẫn để lại half-state. | **Không.** `SharedPreferences` không có `ROLLBACK` nguyên tử theo transaction SQLite. |
| **Defense-in-Depth ở Tầng SQL** | **Có.** Câu `DELETE FROM local_*` có thể ràng buộc trực tiếp `AND NOT EXISTS (...)`. | **Không.** Câu SQL không thể tham chiếu khóa nằm ở XML/plist. | **Phức tạp cao**, dễ sinh Split-Brain giữa 2 SSoT. |
| **Chi phí / Tác động Mở khóa** | Trung bình: Cần mở khóa có kiểm soát 3 frozen files (`OfflineDatabase`, `GuestProfileIdentityProvider`, `GuestClaimCoordinator`), nâng `v5 -> v6`, kèm migration từ `SharedPreferences`. | Thấp hơn về schema nhưng **không giải quyết triệt để P0 Race & Crash**. | Cao nhất (vi phạm KISS/YAGNI), vẫn không đạt invariant P0. |

**Quyết định kiến nghị:** Chọn **Option A** — đưa `guest_quarantined_scopes` vào SQLite schema `v6` làm SSoT duy nhất cho toàn bộ quyết định quarantine/purge. *(Có thể kèm thêm thin async mutex nội bộ trong `GuestProfileIdentityProvider` / lifecycle coordinator nhằm giảm va chạm `SQLITE_BUSY`, nhưng tuyệt đối không dùng Dart mutex làm ranh giới an toàn thay thế SQLite transaction.)*

---

## 3. Thiết kế Chi tiết SQLite v6: Thứ tự Ghi, Locking, Crash Recovery & Dual-Source Migration (Hạng mục 3)

### 3.1 Thiết kế Bảng Mới SQLite `v6`

Tạo bảng thứ 15 hoàn toàn **additive** (bảo toàn 100% 14 bảng `v2–v5`):

```sql
CREATE TABLE IF NOT EXISTS guest_quarantined_scopes (
  guest_profile_id TEXT PRIMARY KEY,
  quarantined_at_ms INTEGER NOT NULL,
  source_user_id TEXT,
  reason TEXT NOT NULL DEFAULT 'SKIP_CLAIM'
);
```

*Ghi chú thiết kế:* `guest_profile_id TEXT PRIMARY KEY` tự tạo B-Tree index duy nhất cho mọi truy vấn kiểm tra `WHERE guest_profile_id = ?` và `NOT EXISTS (...)` ở tốc độ $O(\log N)$, không trùng lặp bản ghi. Cột `source_user_id` và `reason` (`'SKIP_CLAIM'`, `'LEGACY_PREFS_MIGRATED'`) hỗ trợ kiểm toán nguồn gốc cách ly và triage lỗi nâng cấp.

### 3.2 Thứ tự Ghi & Cơ chế Transaction Locking (Loại bỏ Khe hở Snapshot WAL)

Điểm tinh tế kỹ thuật trong SQLite WAL: nếu một transaction bắt đầu ở chế độ `DEFERRED`, các câu `SELECT` ban đầu chỉ lấy *read snapshot* và **chưa** lấy writer lock (`RESERVED/EXCLUSIVE`) cho tới câu `INSERT`/`UPDATE`/`DELETE` đầu tiên. Do đó, thiết kế v6 cưỡng chế thứ tự khóa và kiểm tra **sau khi đã nắm writer lock**:

#### A. Luồng `GuestClaimCoordinator.skipClaim(String userId)` (1 Transaction Duy nhất)
Thực thi trọn vẹn `Step 1 + Step 2` bên trong `await _offlineDb.database.transaction((txn) async { ... })`:
1. **Kiểm tra trạng thái sổ cái trong `txn`:** Truy vấn `guest_claim_recovery_journal` theo `claim_id` / `guest_profile_id`. Nếu `phase IN ('committing', 'committedServer')` -> rollback và ném `StateError('Cannot skip claim once commit has started')` (đóng race nếu crash recovery vừa chuyển `committing`).
2. **Ghi Quarantine SSoT:** Thực thi `INSERT OR IGNORE INTO guest_quarantined_scopes(guest_profile_id, quarantined_at_ms, source_user_id, reason) VALUES (?, ?, ?, 'SKIP_CLAIM')`. Ngay tại lệnh `INSERT` này, SQLite chắc chắn nắm **exclusive write lock** trên DB.
3. **Xóa Journal `prepared`:** Thực thi `DELETE FROM guest_claim_recovery_journal WHERE claim_id = ? AND user_id = ?`.
4. **`COMMIT` vật lý:** Từ bước 2 tới `COMMIT`, không một writer nào (dù ở connection #2 hay isolate #2) có thể đọc thấy trạng thái "đã xóa journal nhưng chưa có quarantine". Handoff là **Zero-Gap 100%**.

#### B. Luồng `SyncStorageDal.purgeGuestLocalScope(...)` (Read-After-Write-Lock Defense-in-Depth)
1. **Pre-Transaction Gate:**
   - Kiểm tra 4 hàng rào [`SyncWriteAdmission`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/authority/sync_write_admission.dart#L84-L93) + khớp đơn trị `reason <-> admission` (Mục 6).
   - Bảo đảm nếu có `guestProfileProvider` gắn legacy `SharedPreferences` chưa migrate xong thì thực hiện **idempotent migration trước khi mở purge** (chi tiết ở Mục 3.4).
   - Nếu `!snap.isAuthenticated`: kiểm tra `guestProfileId != currentGuestId`.
2. **Bên trong `_runWriteTransaction` (`db.transaction`):**
   - **Pre-Delete Check:** Query `guest_quarantined_scopes` và `guest_claim_recovery_journal` theo `guestProfileId` -> nếu tồn tại bất kỳ dòng nào, `throw PurgeProhibitedError`.
   - **Conditional SQL Delete trên 4 bảng `local_*` (`local_preferences`, `local_library_bookmarks`, `local_reading_progress`, `local_reading_history`):**
     ```sql
     DELETE FROM <table_name>
     WHERE owner_scope = ?
       AND NOT EXISTS (
         SELECT 1 FROM guest_quarantined_scopes WHERE guest_profile_id = ?
       )
       AND NOT EXISTS (
         SELECT 1 FROM guest_claim_recovery_journal WHERE guest_profile_id = ?
       );
     ```
     *Tác dụng khóa kép:* Nếu trước lúc `DELETE` chạy có một writer khác (`skipClaim`) vừa commit xen kẽ làm thay đổi snapshot, câu `DELETE` đầu tiên sẽ lập tức gặp `SQLITE_BUSY_SNAPSHOT` (rollback & retry ở vòng ngoài) hoặc chờ lock tới lượt; ngay khi `DELETE` chạy xong, connection này chắc chắn **đang giữ write lock độc quyền cho tới sau `COMMIT`**.
   - **Hook (nếu có) & Post-Write-Lock Re-Verification (Barrier 4):** Chạy lại query kiểm tra `guest_quarantined_scopes`, `guest_claim_recovery_journal` (và kiểm tra lại admission + persisted active guest ID). Nếu phát hiện bất kỳ vi phạm nào -> `throw PurgeProhibitedError` khiến SQLite rollback toàn bộ các bảng `local_*` đã xóa ở trên.
   - **`COMMIT` vật lý:** Vì write lock được giữ liên tục cho tới sau `COMMIT`, **cửa sổ hậu-callback bị triệt tiêu hoàn toàn** — mọi kết nối/isolate khác muốn ghi `guest_quarantined_scopes` hoặc `guest_claim_recovery_journal` buộc phải xếp hàng sau `COMMIT`.

### 3.3 Ma trận Phục hồi Sự cố (Crash Recovery Matrix)

| Điểm Process Crash / Kill | Trạng thái SQLite trên Đĩa Sau Restart | Hành vi Phục hồi Tự động | Đảm bảo Toàn vẹn Dữ liệu |
|---|---|---|---|
| **1. Crash giữa `skipClaim()` trước `COMMIT`** (sau `INSERT quarantine`, trước hoặc sau `DELETE journal`) | SQLite rollback nguyên tử: `guest_quarantined_scopes` **chưa có** dòng mới, `guest_claim_recovery_journal` vẫn giữ nguyên `phase = 'prepared'`, `local_*` còn nguyên. | Lần mở app / login tiếp theo, [`GuestClaimCoordinator.checkCrashRecovery`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/claim/guest_claim_coordinator.dart#L590-L715) thấy dòng `prepared` nên mở lại modal Claim để user chọn lại Merge hoặc Skip; đồng thời mọi lệnh `purgeGuestLocalScope` đều bị journal `prepared` chặn. | **0% mất dữ liệu, 0% split-state.** |
| **2. Crash ngay sau `skipClaim()` `COMMIT`** (trước lúc `resolveToAccount` mở UI) | `guest_quarantined_scopes` đã có `guestProfileId`, journal đã sạch, `local_*` nguyên vẹn. | User đăng nhập lại sẽ không bị kẹt claim cũ (vì journal đã xong) và `guest:gOld` được bảo vệ vĩnh viễn bởi bảng `guest_quarantined_scopes`. | **Bảo toàn 100% guest đã skip.** |
| **3. Crash giữa `purgeGuestLocalScope()`** (sau khi xóa 2/4 bảng `local_*`) | SQLite rollback toàn phần nhờ chưa `COMMIT`. | Cả 4 bảng `local_*` còn nguyên vẹn 100%. | **Không có partial purge.** |
| **4. Crash giữa Dual-Source Migration (`SharedPreferences -> v6`) trước `COMMIT`** | SQLite rollback bảng `guest_quarantined_scopes`; key `omninovel_quarantined_guest_profiles` trong `SharedPreferences` vẫn nguyên vẹn và chưa có flag `migrated_v6`. | Lần restart kế tiếp, migration chạy lại hoàn toàn idempotent (`INSERT OR IGNORE`). | **Không rớt bất kỳ quarantine ID nào từ v5.** |
| **5. Crash sau SQLite Migration `COMMIT` nhưng trước khi đặt flag trong `SharedPreferences`** | SQLite đã có đủ IDs; `SharedPreferences` vẫn còn list cũ & chưa có flag. | Lần restart kế tiếp chạy lại `INSERT OR IGNORE` (idempotent, giữ nguyên `quarantined_at_ms` gốc nếu đã tồn tại), sau đó mới đặt flag `migrated_v6 = true`. | **Idempotent tuyệt đối.** |

### 3.4 Dual-Source Migration (`SharedPreferences -> SQLite v6`) & Tình huống Nâng cấp Ứng dụng

Một ràng buộc quan trọng đã xác minh tại [`OfflineDatabase._onUpgrade`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/storage/offline_database.dart#L95-L125): callback `_onUpgrade(Database db, int oldVersion, int newVersion)` chỉ nhận SQLite `Database db` và không tự truy cập được `SharedPreferences`. Do đó, chiến lược di trú dữ liệu từ key `'omninovel_quarantined_guest_profiles'` phải theo **Mô hình 2 Pha Kết hợp Fallback Fail-Closed**:

1. **Pha 1 — Schema DDL (`OfflineDatabase._onUpgrade`, khi `oldVersion < 6`):**
   - Tạo bảng trống `guest_quarantined_scopes` hoàn toàn additive. Không phụ thuộc `SharedPreferences` trong DDL nên các unit test mở `OfflineDatabase` thuần SQLite vẫn chạy độc lập.
2. **Pha 2 — Hydrate Idempotent Có Thứ Tự (`GuestProfileIdentityProvider.migrateLegacyQuarantinesToSqlite()`):**
   - Trong [`AppBootstrap.run()`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/app/bootstrap.dart#L76-L149): khởi tạo `OfflineDatabase.initialize()` **trước**, truyền vào `GuestProfileIdentityProvider(prefs: rawPrefs, offlineDatabase: offlineDatabase)`, và **`await guestProfileProvider.migrateLegacyQuarantinesToSqlite()` ngay trước khi chạy `authService.initializeAuth()` / `authScopeBridge.settle()`** (bảo đảm xong trước bất kỳ worker eviction nào).
   - Bên trong `migrateLegacyQuarantinesToSqlite()` (bọc bởi in-memory future lock `_migrationFuture` chống gọi trùng):
     1. Đọc `legacyIds = prefs.getStringList('omninovel_quarantined_guest_profiles') ?? []`. Lọc chuỗi rỗng/khoảng trắng.
     2. Nếu danh sách không rỗng và có `offlineDatabase`: mở `db.transaction((txn) async { ... })`, thực thi `INSERT OR IGNORE INTO guest_quarantined_scopes (guest_profile_id, quarantined_at_ms, source_user_id, reason) VALUES (?, ?, NULL, 'LEGACY_PREFS_MIGRATED')`.
     3. Query verify trong `txn` rằng toàn bộ `legacyIds` hợp lệ đều đã hiện diện trong `guest_quarantined_scopes`.
     4. **CHỈ SAU KHI `COMMIT` SQLite thành công:** Ghi marker `'omninovel_quarantined_profiles_migrated_v6': true` vào `SharedPreferences`.
   - **Chính sách giữ Legacy Key (`omninovel_quarantined_guest_profiles`):** **KHÔNG** xóa ngay list cũ trong `SharedPreferences` ở phiên bản v6.0 (đặt ở trạng thái read-only legacy shadow, giữ tối thiểu tới v6.x mới cân nhắc prune). Đồng thời trong [`listQuarantinedGuestScopes`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/identity/guest_profile_identity_provider.dart#L63-L66) và `isGuestScopeQuarantined`: tự động chạy `_ensureLegacyQuarantinesMigrated()` (nếu caller không khởi động qua `AppBootstrap`), và hợp nhất (`UNION`) kết quả SQLite với `prefs.getStringList(...)` nếu migration chưa hoàn tất.

#### Các Edge Cases Nâng cấp & Hạ cấp Ứng dụng đã Kiểm định
- **Upgrade nhảy cóc (`v2/v3/v4/v5 -> v6`):** `_onUpgrade` giữ nguyên chuỗi điều kiện `if (oldVersion < 3) ... if (oldVersion < 4) ... if (oldVersion < 5) ... if (oldVersion < 6)` nên mọi bảng cũ và dữ liệu đều được giữ 100%, tiếp theo là hydrate từ `SharedPreferences`.
- **Dữ liệu `SharedPreferences` bẩn ở bản cũ:** Danh sách chứa phần tử rỗng `''`, khoảng trắng, hoặc ID trùng lặp -> hàm migrate chuẩn hóa `trim()`, bỏ rỗng, deduplicate trước khi `INSERT OR IGNORE`.
- **Ảnh hưởng từ `PreferencesService.clearPreferences()`:** Tại [`preferences_service.dart#L63`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/storage/preferences_service.dart#L63), các key tiền tố `'omninovel_'` được bảo toàn; khi chuyển về SQLite, ngay cả trường hợp OS cloud-backup khôi phục thiếu `SharedPreferences` nhưng còn tệp `.db`, danh sách quarantine vẫn đồng bộ 100% cùng `local_*`.
- **App Downgrade (`v6 -> v5`):** Hiện tại [`OfflineDatabase.initialize`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/storage/offline_database.dart#L48-L66) **không cấu hình `onDowngrade`**. Theo mặc định `sqflite`, mở DB v6 bằng binary v5 sẽ **ném `DatabaseException` (fail-closed)** thay vì xóa DB. **Nghiêm cấm tuyệt đối** sử dụng `onDatabaseDowngradeDelete` vì sẽ phá hủy `offline_chapters`, `guest_claim_recovery_journal` và `guest_quarantined_scopes`. Việc giữ read-only key cũ ở `SharedPreferences` cũng giúp dữ liệu quarantine cũ từ thời v5 không bị mất oan nếu môi trường dev rollback schema.

---

## 4. Đánh giá Tác động Mở khóa Frozen Modules (`GuestProfileIdentityProvider`, `GuestClaimCoordinator`, `OfflineDatabase`) (Hạng mục 4)

Dựa trên kết quả grep toàn bộ `apps/mobile/lib/` và `apps/mobile/test/`, phạm vi ảnh hưởng khi được Hội đồng cho phép mở khóa 3 module như sau:

| Module Mở khóa | Thay đổi Dự kiến | Tác động API / Callers trong `lib/` | Tác động Trực tiếp lên Tests Hiện hành |
|---|---|---|---|
| **[`OfflineDatabase`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/storage/offline_database.dart)** | Nâng `databaseVersion` `5 -> 6`; thêm `_createV6QuarantineTable(db)` vào `_onCreate` và `if (oldVersion < 6)` trong `_onUpgrade`. | Không đổi signature `initialize()`; 14 bảng v2–v5 giữ nguyên 100%. | **2 tệp test cần cập nhật assertion version cứng:**<br>- [`offline_database_v5_migration_test.dart#L42`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/storage/offline_database_v5_migration_test.dart#L42) (`expect(OfflineDatabase.databaseVersion, 5)`) & [`#L566`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/storage/offline_database_v5_migration_test.dart#L566) (`expect(await db.getVersion(), 5)`).<br>- [`offline_database_v3_migration_test.dart#L162`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/storage/offline_database_v3_migration_test.dart#L162) & [`offline_database_migration_v4_test.dart#L245`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/storage/offline_database_migration_v4_test.dart#L245) đang dùng biến động `OfflineDatabase.databaseVersion` (chỉ cần chỉnh chuỗi `reason` nếu muốn đồng bộ chữ v6).<br>- [`storage_quota_eviction_acceptance_test.dart#L148`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart#L148) (`>= 2`) giữ nguyên PASS. |
| **[`GuestProfileIdentityProvider`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/identity/guest_profile_identity_provider.dart)** | Bổ sung tham số optional `OfflineDatabase? offlineDatabase`; thêm `{Transaction? txn, String? sourceUserId, String reason}` cho `quarantineGuestScope` & `listQuarantinedGuestScopes`; thêm `isGuestScopeQuarantined` & `migrateLegacyQuarantinesToSqlite()`. | - **Trong [`AppBootstrap.run()`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/app/bootstrap.dart#L85-L97):** hiện tạo `guestProfileProvider` (dòng `85`) *trước* `offlineDatabase.initialize()` (dòng `96`). Cần đưa `offlineDatabase.initialize()` lên trước để truyền non-null `offlineDatabase` vào `guestProfileProvider` (an toàn vì `OfflineDatabase` không phụ thuộc `prefs`/`ActiveScopeCoordinator`).<br>- [`ActiveScopeCoordinator`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/identity/active_scope_coordinator.dart#L141-L199) chỉ gọi `getOrCreateGuestProfileId()` / `rotateGuestProfileId()`, không bị ảnh hưởng. | - **>25 điểm gọi `GuestProfileIdentityProvider(prefs: prefs)` trong test** (như [`active_scope_coordinator_test.dart#L100-L267`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/identity/active_scope_coordinator_test.dart#L100-L267), `auth_scope_bridge_test.dart`, `guest_identity_isolation_test.dart`, `guest_library_repository_test.dart`, `sync_authority_remediation_test.dart`) **không gãy biên dịch** nhờ giữ `offlineDatabase` là optional ở constructor mặc định (production bootstrap truyền non-null).<br>- [`preferences_service_test.dart#L17,L33`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/storage/preferences_service_test.dart#L17-L33) giữ PASS do legacy key vẫn là `omninovel_*`. |
| **[`GuestClaimCoordinator`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/claim/guest_claim_coordinator.dart)** | Chỉ sửa thân hàm [`skipClaim`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/claim/guest_claim_coordinator.dart#L532-L585) thành **1 `_offlineDb.database.transaction` duy nhất** gọi `quarantineGuestScope(..., txn: txn)` + `txn.delete('guest_claim_recovery_journal', ...)`. | Constructor [`GuestClaimCoordinator(...)`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/claim/guest_claim_coordinator.dart#L49-L63) vốn **đã có** `_offlineDb` và `_guestProvider`, nên không đổi signature; [`LocalLibraryDao.rebindScope`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/storage/local_library_dao.dart#L368-L595) không cần sửa. | - **[`guest_claim_coordinator_test.dart#L492`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/claim/guest_claim_coordinator_test.dart#L492) BẮT BUỘC CẬP NHẬT:** dòng `492` đang kiểm tra trực tiếp `prefs.getStringList(GuestProfileIdentityProvider.keyQuarantinedProfiles)`. Khi chuyển SSoT sang SQLite v6, test này phải kiểm tra qua `guestProvider.listQuarantinedGuestScopes()` và row trong bảng SQLite `guest_quarantined_scopes`.<br>- `guest_claim_acceptance_test.dart`, `guest_claim_bottom_sheet_test.dart`, `guest_claim_listener_test.dart` không bị gãy signature. |

---

## 5. Audit `AccountPurgeReason.signOutReset` vs Pending / Quarantined Offline Mutations (Hạng mục 5)

### 5.1 Phát hiện Rủi ro Hiện hữu (`P0/P1 Data Loss Finding`)

Kiểm tra trực tiếp tại [`SyncStorageDal.purgeAccountScope`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart#L2393-L2420):

- Nếu `reason == AccountPurgeReason.fullResyncReset`, DAL chỉ xóa `_accountSyncCacheTablesOnly` (`sync_meta`, `sync_authoritative_replicas`, `snapshot_staging_store`), bảo toàn toàn bộ `pending_mutations`, `quarantined_mutations`, `sync_mutation_sequences` và 4 bảng `local_*`.
- **NHƯNG** nếu `reason == AccountPurgeReason.signOutReset` (hoặc `accountDeleted`), dòng `2400-2402` chọn `_accountFullScopeTables` ([`sync_storage_dal.dart#L2362-L2372`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart#L2362-L2372)) — danh sách này **xóa cả `pending_mutations`, `quarantined_mutations`, và `sync_mutation_sequences`** — và **HOÀN TOÀN KHÔNG kiểm tra** xem account có còn mutation chưa được server xác nhận hoặc mutation đang quarantined chờ triage hay không!
- Điều này mâu thuẫn với chính `evictDetachedAccountScope(..., discardUnsyncedMutations: false)` ([`sync_storage_dal.dart#L2459-L2484`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart#L2459-L2484)) vốn chặn `UNSYNCED_MUTATIONS_PRESENT` theo mặc định.
- Hiện tại ở tầng UI, cả [`HomeScreen`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/features/home/presentation/home_screen.dart#L193) và [`ProfileScreen`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/features/profile/presentation/profile_screen.dart#L197) gọi trực tiếp `authService.logout()`. Nếu Stage 2/3 đấu nối thêm `purgeAccountScope(reason: AccountPurgeReason.signOutReset)` trước `authService.logout()` mà người dùng đang đọc truyện ngoại tuyến hoặc còn `pending_mutations`/`quarantined_mutations`, dữ liệu chưa đồng bộ sẽ **mất vĩnh viễn không cần xác nhận**.

### 5.2 Khuyến nghị Bắt buộc Trước Stage 2/3 Logout Integration

1. **Khóa Fail-Closed tại DAL:** Bổ sung tham số `bool discardUnsyncedMutations = false` vào [`SyncStorageDal.purgeAccountScope`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart#L2393). Khi `reason != AccountPurgeReason.fullResyncReset && !discardUnsyncedMutations`, thực hiện kiểm tra trong transaction (cả trước xóa và ngay trước Barrier 4): nếu tồn tại bản ghi trong `pending_mutations` hoặc `quarantined_mutations` của `ownerScope` -> ném `PurgeProhibitedError('PURGE_PROHIBITED: Active account "$ownerScope" has unsynced or quarantined mutations (UNSYNCED_MUTATIONS_PRESENT).')` và rollback 100%.
2. **Quy trình Logout 3 Nhánh ở Stage 2/3:**
   - *Bước 1 (Best-effort Flush):* Nếu có mạng, worker đẩy `pending_mutations` và nhận ACK trước khi logout.
   - *Bước 2 (Preserve-on-Logout mặc định nếu còn unsynced):* Nếu vẫn còn `pending_mutations` hoặc `quarantined_mutations` và user không chọn xóa bỏ -> chỉ gọi `AuthService.logout()` để tách `account:<userId>` và xoay sang fresh Guest **mà KHÔNG xóa bảng `account:<userId>`** (tận dụng cơ chế phân vùng `owner_scope` vốn đã cô lập dữ liệu hoàn toàn với Guest mới và tài khoản khác, chờ chính `userId` này đăng nhập lại để tiếp tục đồng bộ).
   - *Bước 3 (Confirmed Wipe):* Chỉ truyền `discardUnsyncedMutations: true` cho `signOutReset` (hoặc `accountDeleted`) sau khi người dùng xác nhận tường minh trên hộp thoại cảnh báo mất dữ liệu cục bộ chưa đồng bộ.

---

## 6. Audit `GuestLifecyclePurgeReason.verifiedUnusedGuestEviction` Chống Xóa Nhầm Active Guest (Hạng mục 6)

### 6.1 Các Lớp Bảo vệ Đã Có vs Lỗ Hổng Thực tế Tìm Thấy

1. **Lớp bảo vệ đã hoạt động tốt khi dùng đúng [`UnusedGuestEvictionAdmission`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/authority/sync_write_admission.dart#L369-L460):**
   - `assertAdmitted(targetScope)` kiểm tra tại cả 4 barrier: `scopeState` phải là `guest` hoặc `account` (từ chối `bootstrapping` & `transitioning`), `canMutateUserState == true`, `snapshot.activeScope != authorizedScope`, và `transitionGeneration` chưa đổi.
   - Trong [`purgeGuestLocalScope`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart#L2556-L2568): khi `!snap.isAuthenticated` (kể cả trong `AuthStatus.pendingVerification` nơi `ActiveScopeCoordinator` duy trì `ActiveScopeState.guest`), DAL đối chiếu thêm `guestProfileId == await guestProfileProvider.getOrCreateGuestProfileId()`, chặn cả kịch bản coordinator bị lệch so với persisted Guest ID trên đĩa.
2. **LỖ HỔNG NGHIÊM TRỌNG TÌM THẤY (`P0` Authority Confusion Gap):**
   - Tại [`sync_storage_dal.dart#L2538-L2558`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart#L2538-L2558):
     - Dòng `2538` chỉ chặn khi `reason == userClearedGuestData && admission is! GuestLocalWriteAdmission`.
     - Dòng `2556` lại viết `if (reason == verifiedUnusedGuestEviction && admission is UnusedGuestEvictionAdmission)` — **KHÔNG từ chối `GuestLocalWriteAdmission`!**
     - Hậu quả trực tiếp: Nếu caller truyền **`GuestLocalWriteAdmission`** (capability được cấp cho **chính Active Guest đang hoạt động**) kèm `reason: GuestLifecyclePurgeReason.verifiedUnusedGuestEviction`, toàn bộ khối check `UnusedGuestEvictionAdmission` ở dòng `2556` bị bỏ qua và **Active Guest bị xóa sạch 4 bảng `local_*` dưới danh nghĩa `verifiedUnusedGuestEviction`**.
     - Bằng chứng thực tế trong test: [`sync_authority_remediation_test.dart#L490-L495`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/sync/sync_authority_remediation_test.dart#L490-L495) đã truyền `testGuestAdmission(journalGuestScope)` (kiểu `GuestLocalWriteAdmission`) cho `verifiedUnusedGuestEviction` mà chỉ bị chặn bởi `guest_claim_recovery_journal` chứ chưa bị chặn ở ranh giới reason-admission!
3. **Timing Edge Case `AuthScopeBridge` khi `onLogout()` bất đồng bộ:**
   - Khi [`AuthService.logout()`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/auth/auth_service.dart#L199-L215) hoặc `handleSessionExpired()` đổi `AuthState` về `unauthenticated`, [`AuthScopeBridge`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/identity/auth_scope_bridge.dart#L118-L135) xếp hàng bất đồng bộ `coordinator.onLogout()`. Trong lát cắt microtask trước khi `onLogout()` chạy dòng `194`, `snap.isAuthenticated` đã là `false` nên check `persisted currentGuestId` vẫn bảo vệ Guest hiện tại trước khi `rotateGuestProfileId()` xoay ID, và khi `onLogout()` bump `transitionGeneration`, mọi capability cũ đều hết hạn ngay.

### 6.2 Khuyến nghị Sửa Bắt buộc

Áp dụng **Bijective Reason-Admission Enforcement (Ánh xạ đơn trị 1-1)** ngay đầu `purgeGuestLocalScope`:
- `GuestLifecyclePurgeReason.userClearedGuestData` **CHỈ** chấp nhận `GuestLocalWriteAdmission`.
- `GuestLifecyclePurgeReason.verifiedUnusedGuestEviction` **CHỈ** chấp nhận `UnusedGuestEvictionAdmission` — **ném `PurgeProhibitedError` ngay lập tức nếu nhận `GuestLocalWriteAdmission`!**
- Cập nhật [`sync_storage_dal.dart#L2516-L2558`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart#L2516-L2558) (kể cả doc comment dòng `2518`) và chỉnh lời gọi tại [`sync_authority_remediation_test.dart#L493`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/test/core/sync/sync_authority_remediation_test.dart#L493) dùng `UnusedGuestEvictionAdmission` đúng nghĩa.

---

## 7. Kế hoạch Production DI & Chứng minh Zero-Bypass `SyncStorageDal.bound(...)` / `clientId` (Hạng mục 7)

### 7.1 Hiện trạng tại Stage 1
- Trong [`AppBootstrap.run()`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/app/bootstrap.dart#L70-L198) và [`OmniNovelApp`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/app/app.dart#L1-L61), `SyncClientIdentityProvider` và `SyncStorageDal` **chưa được nối vào DI** (nằm trong ranh giới hoãn tới Stage 2).
- Constructor không ràng buộc [`SyncStorageDal(...)`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart#L41-L68) hiện vẫn là **public** với `SyncClientIdentityProvider? clientIdentityProvider` tùy chọn nullable -> nếu vô tình gọi trong Stage 2 sẽ làm tắt check `_assertBoundClientIdentityIfConfigured` ở dòng `265`.

### 7.2 Kiến trúc Production DI 4 Lớp Chứng minh Không thể Bypass

Khi mở Stage 2, toàn bộ luồng khởi tạo production tuân thủ 4 lớp kiểm soát cứng:

1. **Single-Origin Chain trong `AppBootstrap.run()`:**
   ```text
   PreferencesService.create() (rawPrefs)
     └─► InstallationIdentityProvider(secureStorage, prefs: rawPrefs) [Single Instance]
           ├─► SyncClientIdentityProvider(installationProvider)
           └─► ActiveScopeCoordinator(installProvider, guestProfileProvider)
   OfflineDatabase.initialize() [SQLite v6]
     └─► GuestProfileIdentityProvider(prefs: rawPrefs, offlineDatabase: offlineDatabase)
           └─► await migrateLegacyQuarantinesToSqlite() [Chạy TRƯỚC Auth & Sync]
     └─► SyncStorageDal.bound(
           offlineDatabase: offlineDatabase,
           clientIdentityProvider: syncClientIdentityProvider, // required non-null!
           guestProfileProvider: guestProfileProvider,         // required non-null!
         )
   ```
   Cung cấp singleton `syncStorageDal` và `syncClientIdentityProvider` qua `BootstrapResult` vào `MultiProvider` trong `OmniNovelApp`. Các Repository/Adapter của Stage 2 chỉ nhận `SyncStorageDal` qua DI, cấm tự khởi tạo trực tiếp.

2. **Khóa Constructor Test bằng `@visibleForTesting` + Static Analyzer Gate:**
   - Gắn annotation `@visibleForTesting` lên constructor không bound `SyncStorageDal(...)` / `SyncStorageDal.forTesting(...)` trong `sync_storage_dal.dart`. Như vậy **`SyncStorageDal.bound(...)`** (với `required SyncClientIdentityProvider clientIdentityProvider`) là **constructor public duy nhất** khả dụng cho mã production trong `apps/mobile/lib/**`.
   - Trong [`analysis_options.yaml#L8-L16`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/analysis_options.yaml#L8-L16) (vốn đã nâng `missing_required_param: error`, `missing_return: error`), bổ sung `invalid_use_of_visible_for_testing_member: error` để `flutter analyze` ở CI ([`.github/workflows/ci-cd.yml#L251`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/.github/workflows/ci-cd.yml#L251)) thất bại cứng nếu bất kỳ tệp nào trong `apps/mobile/lib/**` gọi constructor unbound.

3. **Khóa Đầu vào `clientId` via `SyncMutationFactory` + DAL Defense-in-Depth:**
   - Stage 2 cung cấp `SyncMutationFactory` nhận `SyncClientIdentityProvider`, tự lấy `clientId` bền vững (`getOrCreateClientId`) khi tạo `PendingMutationRecord` — tầng UI/Feature không bao giờ truyền string `clientId` thô.
   - Bên trong `SyncStorageDal.bound(...)`, [`_assertBoundClientIdentityIfConfigured`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart#L254-L284) tiếp tục đối chiếu `clientId` ở cả 9 đường mutate/quarantine/requeue chống spoof UUID ngẫu nhiên, chống trùng `userId`, `guestProfileId`, và JWT `sid`.

4. **Architecture Verification Test Bổ sung cho DI:**
   - Test `AppBootstrap.run()` xác nhận `bootstrap.syncStorageDal.hasBoundClientIdentity == true` và từ chối mọi `PendingMutationRecord` mang `clientId` khác với `InstallationIdentityProvider`.
   - Test tĩnh quét cây `apps/mobile/lib/**` xác nhận không có lời gọi `SyncStorageDal(` ngoài chính file `sync_storage_dal.dart` và 1 singleton duy nhất qua `SyncStorageDal.bound(...)` trong `bootstrap.dart`.

---

## 8. Đề xuất Ma trận Kiểm thử Bắt buộc cho Phase Tiếp theo (Hạng mục 8)

| Nhóm Kiểm thử | Các Kịch bản Cốt lõi Bắt buộc Phủ Kín |
|---|---|
| **1. Interleaving & Multi-Connection / Multi-Isolate Concurrency** | - **Dual-Connection Race (`skipClaim` vs `purgeGuestLocalScope`):** Mở 2 `OfflineDatabase` (`singleInstance: false`) trỏ cùng tệp DB WAL; kết nối A giữ transaction trong `purgeGuestLocalScope` (sau 2/4 `DELETE`), kết nối B chạy `skipClaim` (insert `guest_quarantined_scopes`) -> kiểm chứng serialization SQLite lock (`busy_timeout`), zero corruption, A không bao giờ xóa được dữ liệu sau khi B commit quarantine.<br>- **50-Iteration Concurrent Stress Race (`Future.wait`):** Chạy đua ngẫu nhiên `skipClaim` và `purgeGuestLocalScope` -> Bất biến bất khả xâm phạm: **không bao giờ** đồng thời tồn tại bản ghi `guest_quarantined_scopes` và bảng `local_*` rỗng.<br>- **Cross-Isolate (`Isolate.spawn`):** Isolate phụ chạy `quarantineGuestScope`/`skipClaim` trong khi Isolate chính chạy `purgeGuestLocalScope` trên cùng file DB (chứng minh ưu thế tuyệt đối so với Dart Mutex).<br>- **Reason-Admission Bijection:** `verifiedUnusedGuestEviction` truyền `GuestLocalWriteAdmission` phải ném `PurgeProhibitedError`. |
| **2. Process Crash & Fault-Injection Matrix** | - **Crash giữa `skipClaim()` (giữa `INSERT guest_quarantined_scopes` và `DELETE guest_claim_recovery_journal`):** Đóng/throw trên DB wrapper -> mở lại connection mới kiểm tra SQLite rollback 100%, journal `prepared` vẫn nguyên để `checkCrashRecovery` mở lại modal, `local_*` nguyên vẹn.<br>- **Crash giữa Dual-Source Migration (trước & sau SQLite `COMMIT`):** Ném lỗi giữa `txn` trước commit -> restart chạy lại migration không mất phần tử nào; crash sau commit trước khi set `migrated_v6 = true` -> restart chạy lại lần 2 không lỗi PK (`INSERT OR IGNORE`).<br>- **Crash giữa `purgeGuestLocalScope()` (sau 2/4 bảng `local_*`):** Mở lại DB xác nhận cả 4 bảng `local_*` còn đủ 100%.<br>- **Crash recovery sau mọi phase `prepared` / `committing` / `committedServer`:** Cold-reopen DB thử gọi `purgeGuestLocalScope` -> chặn fail-closed với `PurgeProhibitedError`. |
| **3. Migration `v5 -> v6` & Edge Cases `SharedPreferences`** | - **Fresh `v6` Install:** `getVersion() == 6`, đủ **15 bảng**, khóa chính `guest_quarantined_scopes(guest_profile_id)`.<br>- **Additive Upgrade `v2/v3/v4/v5 -> v6`:** Seed dữ liệu đầy đủ ở cả 14 bảng v5 (`offline_*`, `local_*`, `guest_claim_recovery_journal`, `sync_*`) -> upgrade lên `v6` giữ 100% số dòng cũ.<br>- **Legacy Dual-Source Hydration:** `SharedPreferences` chứa `['g-1', 'g-2', '', '  ', 'g-1']` -> migrate vào SQLite sạch trùng & rỗng còn đúng 2 dòng; gọi migration 3 lần liên tiếp không đổi timestamp cũ; test tình huống chưa gọi bootstrap migration nhưng `purgeGuestLocalScope` chạy qua `GuestProfileIdentityProvider` vẫn tự hydrate / UNION fail-closed chặn xóa `'g-1'`.<br>- **Empty/Missing `SharedPreferences`:** Upgrade v6 thành công không lỗi. |
| **4. Downgrade, Rollback, `signOutReset` & DI Proof** | - **Strict Downgrade Guard (`v6 -> v5`):** DB đã upgrade v6 (có dữ liệu `guest_quarantined_scopes` & `local_*`), thử mở lại bằng version `5` không `onDowngrade` -> SQLite ném `DatabaseException` fail-closed, **không** xóa dữ liệu trên đĩa; mở lại bằng `v6` dữ liệu vẫn còn 100%.<br>- **Legacy Key Survival on Failed Migration:** Migration thất bại giữa chừng không bao giờ xóa `omninovel_quarantined_guest_profiles` trong `SharedPreferences`.<br>- **`signOutReset` Guard:** Account còn `pending_mutations` hoặc `quarantined_mutations` gọi `purgeAccountScope(signOutReset)` với default `discardUnsyncedMutations: false` -> ném `PurgeProhibitedError('UNSYNCED_MUTATIONS_PRESENT')`; truyền `true` hoặc queue rỗng mới xóa sạch.<br>- **Production DI Proof:** `AppBootstrap.run()` kiểm chứng `hasBoundClientIdentity == true`, `guestProfileProvider` gắn `offlineDatabase` thực và chặn mọi `clientId` giả mạo. |

---

## 9. Tổng hợp Mức độ Rủi ro & Phạm vi Xin Phê duyệt Gate Review

### 9.1 Bảng Đánh giá Rủi ro

| Mã Rủi ro | Mô tả Rủi ro | Mức độ | Trạng thái Hiện tại (Baseline `a17495a`) | Biện pháp Kiểm soát Đề xuất |
|---|---|---|---|---|
| **R-01** | Cross-store race giữa `SharedPreferences` quarantine và SQLite `purgeGuestLocalScope` (post-callback COMMIT gap, đa isolate, crash giữa 2 bước `skipClaim`) | **`P0` (Critical)** | Còn khe hở hậu-callback trên Dual-Store | Chuyển `guest_quarantined_scopes` thành SQLite `v6` SSoT + 1 transaction `skipClaim` + Post-Write-Lock verification (Option A). |
| **R-02** | `verifiedUnusedGuestEviction` truyền nhầm `GuestLocalWriteAdmission` làm xóa Active Guest | **`P0` (Critical)** | **Chưa chặn** tại `sync_storage_dal.dart:2538-2568` | Cưỡng chế ánh xạ 1-1: `verifiedUnusedGuestEviction` CHỈ chấp nhận `UnusedGuestEvictionAdmission`. |
| **R-03** | `AccountPurgeReason.signOutReset` xóa `pending_mutations`/`quarantined_mutations` chưa ACK nếu Stage 2/3 nối vào Logout | **`P0/P1` (High)** | Chưa có check `UNSYNCED_MUTATIONS_PRESENT` | Thêm `discardUnsyncedMutations: false` fail-closed default + Preserve-on-Logout trừ khi user confirm. |
| **R-04** | Rơi rớt danh sách quarantine cũ trong `SharedPreferences` khi nâng cấp v5 -> v6 | **`P1` (High)** | Chưa có v6 | Hydrate idempotent trong `AppBootstrap` + lazy auto-migrate + UNION fallback + giữ legacy key dạng shadow read-only. |
| **R-05** | Bypass `SyncStorageDal.bound(...)` ở Stage 2 khi constructor mặc định còn public | **`P1` (High)** | Constructor mặc định còn public cho Stage 1 test | Khóa bằng `@visibleForTesting` + `analysis_options.yaml` `error` + `AppBootstrap` singleton DI. |
| **R-06** | Downgrade APK v6 -> v5 làm hỏng DB hoặc mất dữ liệu | **`P2` (Medium)** | Fail-closed mặc định (không `onDowngrade`) | Duy trì cấm `onDatabaseDowngradeDelete` + thêm regression test strict reject downgrade. |

### 9.2 Phạm vi Đề xuất Xin Hội đồng Gate Review Phê duyệt (`Controlled Unlock — Stage 1B`)

Để đóng kín triệt để toàn bộ **R-01 .. R-04** trước khi cấp `FROZEN CLEAN` cho Stage 1 (vẫn tách biệt sạch trước khi mở Stage 2 Projection & Background Worker), nhóm thực thi đề xuất Hội đồng phê duyệt mở khóa có kiểm soát phạm vi chính xác sau trên nhánh `feat/7c4-mobile-sync`:

1. **Mở khóa có kiểm soát 3 Frozen Files (phạm vi tối thiểu):**
   - [`apps/mobile/lib/core/storage/offline_database.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/storage/offline_database.dart): Nâng `databaseVersion` `5 -> 6` với bảng additive `guest_quarantined_scopes`.
   - [`apps/mobile/lib/core/identity/guest_profile_identity_provider.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/identity/guest_profile_identity_provider.dart): Bổ sung optional `OfflineDatabase?`, hỗ trợ `Transaction? txn`, `migrateLegacyQuarantinesToSqlite()` idempotent và UNION fallback an toàn.
   - [`apps/mobile/lib/core/claim/guest_claim_coordinator.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/claim/guest_claim_coordinator.dart): Gộp `skipClaim()` vào 1 `db.transaction` duy nhất (chỉ sửa thân `skipClaim`, không đổi API/phase model khác).
   - *(Đảo thứ tự 2 dòng trong [`apps/mobile/lib/app/bootstrap.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/app/bootstrap.dart#L85-L97) để `offlineDatabase.initialize()` chạy trước `guestProfileProvider` và gọi `migrateLegacyQuarantinesToSqlite()`, vẫn giữ nguyên chưa nối `SyncStorageDal` UI adapters cho Stage 2.)*
2. **Cập nhật [`apps/mobile/lib/core/sync/storage/sync_storage_dal.dart`](file:///e:/Workspace2/Doctruyen_project_7c4_mobile/apps/mobile/lib/core/sync/storage/sync_storage_dal.dart):**
   - Khóa `purgeGuestLocalScope` vào SQLite `guest_quarantined_scopes` + SQL `NOT EXISTS` + barrier post-write-lock.
   - Đóng lỗ hổng R-02: chỉ chấp nhận `UnusedGuestEvictionAdmission` cho `verifiedUnusedGuestEviction`.
   - Đóng lỗ hổng R-03: thêm `bool discardUnsyncedMutations = false` vào `purgeAccountScope`.
3. **Cập nhật & Bổ sung Bộ Test:** Cập nhật các assertion cứng ở `offline_database_v5_migration_test.dart`, `guest_claim_coordinator_test.dart#L492`, `sync_authority_remediation_test.dart#L493` và bổ sung đầy đủ 4 nhóm test mục 8 (`v6` migration, interleaving, multi-isolate, crash matrix, downgrade, `signOutReset`).
4. **Giữ Đóng băng Tuyệt đối Cho Tới Gate Stage 2:** Toàn bộ `apps/web/**`, `services/api/**`, `packages/shared/**`, `apps/mobile/lib/core/auth/**`, `local_library_dao.dart`, `deploy/**`, `.github/**`, `.trivyignore`, trạng thái `UNINITIALIZED` (cấm cấp `READY`), và không gộp PR `#209` vào `main`.
