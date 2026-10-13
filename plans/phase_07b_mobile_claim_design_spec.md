# 📱 Design Specification: Task 7B.3 — Mobile Client Integration (Account Claim & Scope Coordination)

> **Mã công việc:** Task 7B.3 (Mobile Client Integration)  
> **Trạng thái:** `APPROVED WITH CONDITIONS — SPEC AMENDMENT REVIEW`  
> **Căn cứ kỹ thuật:**
> - [plans/ROADMAP.md](ROADMAP.md) (Task 7B.3 Web = FROZEN CLEAN at `9f74ea1`, Hosted CI Run #435 Green 7/7)
> - [plans/product/identity_and_ownership_model.md](product/identity_and_ownership_model.md) (SSoT Identity & Ownership)
> - [plans/product/guest_to_account_claim_protocol.md](product/guest_to_account_claim_protocol.md) (SSoT Claim Protocol)
> - [plans/phase_07b_account_claim_implementation_plan.md](phase_07b_account_claim_implementation_plan.md) (Phase 7B Implementation Plan)

---

## 1. Tổng Quan & Mục Tiêu Kiến Trúc

Task 7B.3 Mobile Client Integration hoàn thiện luồng chuyển giao dữ liệu Khách sang Tài khoản (Guest-to-Account Claim) trên ứng dụng Flutter di động. Nhiệm vụ cốt lõi là bảo đảm **tính toàn vẹn dữ liệu, triệt tiêu race condition ghi đè tài khoản, chống tái sinh dữ liệu đã xóa (Anti-Resurrection), phân định ranh giới phục hồi sau sự cố (Crash Recovery)** và bảo toàn tính độc lập của phân vùng lưu trữ ngoại tuyến.

### 5 Nguyên Tắc Bất Biến Bổ Sung (P0 Amendments)
1. **P0-1 — Authority Duy Nhất Mở Scope ACCOUNT & Application Shell Orchestration:**
   - `AuthScopeBridge` và `ActiveScopeCoordinator` tuyệt đối không tự ý mở scope `account:<userId>` ngay khi nhận `AuthStatus.authenticated`.
   - `GuestClaimCoordinator` là **thẩm quyền duy nhất** kích hoạt `resolveToAccount(userId)` sau khi đã xác minh chắc chắn: (a) Không có dữ liệu khách, (b) Người dùng chọn Bỏ qua (Skip), hoặc (c) Claim đã commit và rebind local thành công.
   - `GuestClaimBottomSheet` được điều phối từ tầng Root Application Shell (`AppShell` / Top-level Builder), không phụ thuộc vòng đời riêng của `LoginScreen` (vì GoRouter tự redirect khi `authenticated`).
2. **P0-2 — Phân Biệt Bootstrap Readiness vs Scope Resolution (Chống Deadlock Khởi Động):**
   - Phân định rạch ròi 3 trạng thái:
     * `bootstrapReady`: Khởi tạo đủ hạ tầng (DB, storage, config, auth, router) để dựng giao diện.
     * `scopeResolved`: Scope đã giải quyết dứt khoát sang `GUEST` hoặc `ACCOUNT`, kích hoạt quyền ghi `canMutateUserState = true`.
     * `TRANSITIONING`: Cho phép render UI xử lý claim, nhưng cấm tuyệt đối mọi hành vi ghi đè dữ liệu người dùng (`canMutateUserState = false`).
   - `bootstrap.dart` không dùng `waitForResolvedScope()` làm điều kiện chặn khởi tạo Router khi app đang có claim pending.
   - Khi app cold start có recovery context, lỗi mạng tạm thời tại `/auth/me` không được tự ý coi là logout rồi xoay `guestProfileId`.
3. **P0-3 — Durable Recovery Context (`PendingGuestClaim`):**
   - Lưu trữ bền vững toàn bộ context phục hồi (bao gồm `conflictDecisions` và phase) vào `SharedPreferences` **trước khi** gửi request `/commit`.
   - Quản lý ma trận phục hồi sự cố nghiêm ngặt, đối soát đúng `userId` và `guestProfileId` nguồn. Chỉ xóa recovery context sau khi local finalization hoàn tất 100%.
4. **P0-4 — SQLite Rebind Tôn Trọng Quyết Định Của Server (Anti-Resurrection & Cloud Precedence):**
   - Xung đột tiến độ đọc: Nếu user chọn `KEEP_CLOUD`, ngay cả khi SQLite chưa cache Cloud progress thì Mobile vẫn lấy `conflict.cloudProgress` từ server ghi vào `account:<userId>`.
   - Chống hồi sinh (Anti-Resurrection): Không blind-copy các câu chuyện bị tombstoned trên Cloud vào account cache. Kích hoạt Authoritative Cloud Reconciliation sau commit để đồng bộ trạng thái chính thức.
5. **P0-5 — Tách Rời SQLite Local Library Transaction Khỏi Offline Filesystem Handover:**
   - SQLite Transaction chỉ áp dụng nguyên tử cho 3 bảng của Local Library: `local_library_bookmarks`, `local_reading_progress`, `local_reading_history`.
   - Phân vùng file tải ngoại tuyến (`files/offline/<userScope>/...`) và bảng download (`offline_chapters`, `download_tasks`) được bảo toàn partition guest an toàn, không xóa và không blind-rename trong luồng claim thư viện.

---

## 2. Chi Tiết Thiết Kế Từng Tầng Kỹ Thuật

### 2.1. Tầng Trạng Thái & Điều Phối Định Danh (Identity & Scope State Machine)

#### `ActiveScopeCoordinator` ([apps/mobile/lib/core/identity/active_scope_coordinator.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/identity/active_scope_coordinator.dart))
- Bổ sung phương thức explicit:
  * `void setTransitioning()`: Đưa trạng thái sang `ActiveScopeState.transitioning`, set `_activeScope = null`, `canMutateUserState = false`, phát sự kiện `notifyListeners()`.
  * `void resolveToAccount(String userId)`: Nhận `userId`, trim khoảng trắng. Nếu rỗng -> fallback fail-closed về `bootstrapping`. Nếu hợp lệ -> `_activeScope = 'account:$trimmed'`, `_state = ActiveScopeState.account`, flush toàn bộ waiters trong `_waiters`, phát sự kiện `notifyListeners()`.
  * Sửa đổi `onAuthStatusChanged(AuthStatus status, {String? userId, bool deferScopeResolution = false})`:
    ```dart
    case AuthStatus.authenticated:
      final trimmed = userId?.trim();
      if (trimmed == null || trimmed.isEmpty) {
        _state = ActiveScopeState.bootstrapping;
        _activeScope = null;
        notifyListeners();
        break;
      }

      if (deferScopeResolution || _state == ActiveScopeState.transitioning) {
        // P0 Invariant: Giữ khóa TRANSITIONING, cấm ghi account mutation!
        setTransitioning();
        break;
      }

      resolveToAccount(trimmed);
      break;
    ```

#### `AuthScopeBridge` ([apps/mobile/lib/core/identity/auth_scope_bridge.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/identity/auth_scope_bridge.dart))
- Khi `nextStatus == AuthStatus.authenticated`:
  * Luôn truyền `deferScopeResolution: true` vào `_coordinator.onAuthStatusChanged(...)` nếu caller chưa hoàn tất claim check, hoặc ủy quyền cho `GuestClaimCoordinator` làm authority mở account.

---

### 2.2. Durable Recovery Context & State Machine của Claim

#### Model `PendingGuestClaim` ([apps/mobile/lib/core/claim/models/pending_guest_claim.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/claim/models/pending_guest_claim.dart))
```dart
enum ClaimRecoveryPhase {
  prepared,           // Đã prepare thành công, đang chờ user tương tác BottomSheet
  committing,         // Đã lưu conflict decisions, đang gửi HTTP /commit
  committedServer,    // Server đã trả 200 COMMITTED, đang thực hiện SQLite Local Merge
  rebindCompleted,    // SQLite Local Merge hoàn tất, đang dọn partition nguồn
}

class PendingGuestClaim {
  final String claimId;
  final String userId;
  final String guestProfileId;
  final String expectedStateFingerprint;
  final Map<String, ConflictResolution> conflictDecisions;
  final ClaimRecoveryPhase phase;
  final String createdAt;

  const PendingGuestClaim({
    required this.claimId,
    required this.userId,
    required this.guestProfileId,
    required this.expectedStateFingerprint,
    this.conflictDecisions = const {},
    required this.phase,
    required this.createdAt,
  });

  Map<String, dynamic> toJson();
  factory PendingGuestClaim.fromJson(Map<String, dynamic> json);
  PendingGuestClaim copyWith({ClaimRecoveryPhase? phase, Map<String, ConflictResolution>? conflictDecisions});
}
```

#### Ma Trận Xử Lý Crash Recovery ([core/claim/guest_claim_coordinator.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/claim/guest_claim_coordinator.dart))
| Tình huống kiểm tra | Trạng thái máy chủ | Hành vi Mobile thực thi |
|---|---|---|
| `pending.userId != currentUserId` | Bất kỳ | Không can thiệp, bỏ qua claim của user khác, bảo vệ isolation |
| Normal Crash Recovery | `COMMITTED` | Thực thi SQLite Transactional Rebind (idempotent), dọn dẹp partition nguồn, xóa recovery context, gọi `resolveToAccount` |
| Normal Crash Recovery | `PREPARED` | Giữ scope `TRANSITIONING`, mở lại `GuestClaimBottomSheet` kèm preview data |
| Normal Crash Recovery | `EXPIRED` hoặc `ABORTED` | Nếu SQLite khách vẫn còn dữ liệu: tạo phiên prepare mới; không tự ý bỏ qua |
| Kiểm tra status mất mạng / offline | Lỗi mạng | Giữ nguyên scope `TRANSITIONING` (`PENDING_UNAVAILABLE`), cung cấp nút Thử lại |
| Lỗi mạng khi đang gửi `/commit` | Timeout / 5xx | Gọi `GET /status` kiểm tra xem commit đã vào DB server chưa trước khi quyết định retry hay rebind |
| Lỗi SQLite Rebind nội bộ | Exception | Giữ recovery context, cho phép thử lại rebind mà không mất dữ liệu |

---

### 2.3. SQLite Transactional Rebind & Authoritative Reconciliation

#### Phương thức tại `LocalLibraryDao` ([apps/mobile/lib/core/storage/local_library_dao.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/storage/local_library_dao.dart))
1. **`hasGuestData(String ownerScope) -> Future<bool>`:**
   - Đếm số bản ghi trong `local_library_bookmarks`, `local_reading_progress`, `local_reading_history` của `ownerScope`.
   - **Fail-Closed:** Nếu câu truy vấn SQLite throw exception, lập tức rethrow, không trả `false` giả tạo.
2. **`rebindScope({...}) -> Future<void>`:**
   ```dart
   Future<void> rebindScope({
     required String sourceScope,
     required String targetScope,
     Map<String, ConflictResolution>? conflictDecisions,
     List<ReadingProgressConflict>? previewConflicts,
   }) async {
     await _db.transaction((txn) async {
       // 1. Bookmarks: INSERT OR IGNORE chống crash Primary Key (owner_scope, story_id)
       await txn.execute('''
         INSERT OR IGNORE INTO local_library_bookmarks (owner_scope, story_id, title, slug, cover_url, created_at)
         SELECT ?, story_id, title, slug, cover_url, created_at
         FROM local_library_bookmarks
         WHERE owner_scope = ?
       ''', [targetScope, sourceScope]);

       // 2. Reading History: Monotonic MAX merge
       await txn.execute('''
         INSERT INTO local_reading_history (owner_scope, story_id, chapter_id, chapter_version_id, story_title, story_slug, story_cover_url, chapter_number, chapter_title, progress_percentage, last_read_at)
         SELECT ?, story_id, chapter_id, chapter_version_id, story_title, story_slug, story_cover_url, chapter_number, chapter_title, progress_percentage, last_read_at
         FROM local_reading_history
         WHERE owner_scope = ?
         ON CONFLICT(owner_scope, story_id, chapter_id) DO UPDATE SET
           progress_percentage = MAX(local_reading_history.progress_percentage, EXCLUDED.progress_percentage),
           last_read_at = MAX(local_reading_history.last_read_at, EXCLUDED.last_read_at)
       ''', [targetScope, sourceScope]);

       // 3. Reading Progress: Conflict-Aware & Cloud Precedence Merge
       // 3a. Xử lý các truyện bị conflict:
       final conflicts = previewConflicts ?? const [];
       for (final conflict in conflicts) {
         final decision = conflictDecisions?[conflict.storyId] ?? ConflictResolution.keepCloud;
         if (decision == ConflictResolution.keepCloud) {
           // P0-4: Ghi authoritative cloudProgress từ server vào targetScope (kể cả khi local target chưa có)
           final cp = conflict.cloudProgress;
           await txn.rawInsert('''
             INSERT OR REPLACE INTO local_reading_progress (
               owner_scope, story_id, chapter_id, chapter_version_id, reading_mode,
               page_index, scroll_position, progress_percentage, anchor_block_id, text_offset, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ''', [
             targetScope, conflict.storyId, cp.chapterId, cp.chapterVersionId, cp.readingMode.value,
             cp.pageIndex, cp.scrollPosition, cp.progressPercentage, cp.anchorBlockId, cp.textOffset, cp.updatedAt
           ]);
         } else {
           // USE_GUEST: Lấy guestProgress từ sourceScope ghi đè targetScope
           final gp = conflict.guestProgress;
           await txn.rawInsert('''
             INSERT OR REPLACE INTO local_reading_progress (
               owner_scope, story_id, chapter_id, chapter_version_id, reading_mode,
               page_index, scroll_position, progress_percentage, anchor_block_id, text_offset, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ''', [
             targetScope, conflict.storyId, gp.chapterId, gp.chapterVersionId, gp.readingMode.value,
             gp.pageIndex, gp.scrollPosition, gp.progressPercentage, gp.anchorBlockId, gp.textOffset, gp.updatedAt
           ]);
         }
       }

       // 3b. Xử lý các truyện không conflict: chỉ insert nếu targetScope chưa có bản ghi
       await txn.execute('''
         INSERT OR IGNORE INTO local_reading_progress (
           owner_scope, story_id, chapter_id, chapter_version_id, reading_mode,
           page_index, scroll_position, progress_percentage, anchor_block_id, text_offset, updated_at
         )
         SELECT ?, story_id, chapter_id, chapter_version_id, reading_mode,
                page_index, scroll_position, progress_percentage, anchor_block_id, text_offset, updated_at
         FROM local_reading_progress
         WHERE owner_scope = ?
       ''', [targetScope, sourceScope]);

       // 4. Purge sạch phân vùng nguồn guest
       await txn.delete('local_library_bookmarks', where: 'owner_scope = ?', whereArgs: [sourceScope]);
       await txn.delete('local_reading_progress', where: 'owner_scope = ?', whereArgs: [sourceScope]);
       await txn.delete('local_reading_history', where: 'owner_scope = ?', whereArgs: [sourceScope]);
     });
   }
   ```

---

### 2.4. Ranh Giới Nội Dung Ngoại Tuyến (Offline Filesystem Handover)

1. **Cô lập Transaction:** Thao tác SQLite rebind ở trên **tuyệt đối không** bao gồm các lệnh filesystem I/O di chuyển thư mục `files/offline/<userScope>`.
2. **Nguyên tắc bảo toàn partition:**
   - Thư mục offline của guest được bảo toàn nguyên trạng, không thực hiện blind rename hoặc xóa hàng loạt.
   - Khi người dùng đăng nhập và claim, các quyền đọc chương đã tải được duy trì truy cập dựa trên installation token cục bộ mà không làm rách nát dữ liệu staging hay installed.

---

### 2.5. Tầng Giao Diện & Điều Phối Ứng Dụng (Presentation & Orchestration)

1. **`GuestClaimBottomSheet` ([apps/mobile/lib/features/claim/presentation/guest_claim_bottom_sheet.dart](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/features/claim/presentation/guest_claim_bottom_sheet.dart)):**
   - Được bọc trong `PopScope(canPop: false)`: Chặn thao tác Back của Android khi claim đang pending hoặc đang commit. Người dùng bắt buộc phải chọn dứt khoát `Gộp vào tài khoản` hoặc `Bỏ qua`.
   - Hiển thị danh sách conflict trực quan (Cloud vs Máy này) kèm Radio chọn giải pháp.
   - Xử lý lỗi mạng: Hiển thị thông báo lỗi rõ ràng và nút `Thử lại (Retry)` thay vì bị treo ở loading spinner vô hạn.
2. **Root Application Shell Orchestration:**
   - Gắn `GuestClaimBottomSheetListener` tại tầng Root Widget của ứng dụng (`OmniNovelApp` hoặc Shell của `GoRouter`).
   - Lắng nghe `GuestClaimCoordinator.isOpen`: Khi `isOpen == true`, tự động gọi `showModalBottomSheet(isDismissible: false, enableDrag: false)`.
   - Nhờ đó, việc điều phối claim hoàn toàn độc lập với việc `LoginScreen` bị dismiss hay `GoRouter` chuyển trang sau đăng nhập.

---

### 2.6. Đồng Bộ Điểm Vào Xác Thực (Auth Registration Entrypoint)

- Mở rộng [`AuthService`](file:///e:/Workspace%202/Doctruyen_project/apps/mobile/lib/core/auth/auth_service.dart) với hàm `register({username, email, password})`:
  * Gọi `POST /auth/register` (với auto-login semantics tương đương login).
  * Lưu trữ access token và refresh token.
  * Đặt trạng thái `authenticated` và cùng đi qua một orchestration entrypoint duy nhất để kích hoạt Guest Claim.

---

## 3. Ma Trận Kiểm Thử Chấp Nhận (12 Cross-Layer Acceptance Tests)

| # | Kịch Bản Kiểm Thử | Kỳ Vọng Đạt Được (Expected Outcome) |
|---|---|---|
| **AC-01** | Đăng nhập/Đăng ký thành công, trước khi `checkAndPrepareClaim` xong | Scope giữ nguyên `TRANSITIONING`, `canMutateUserState == false`. Cấm mọi thao tác ghi dữ liệu account. |
| **AC-02** | GoRouter redirect người dùng khỏi màn hình `/login` | `GuestClaimBottomSheet` vẫn hiển thị bình thường ở tầng Root Shell, không bị hủy khi `LoginScreen` unmount. |
| **AC-03** | Khởi động ứng dụng (Cold start) khi đang có `pendingClaim` | Bootstrap khởi tạo xong Router bình thường (`bootstrapReady`), không bị deadlock chờ `waitForResolvedScope()`. |
| **AC-04** | Ứng dụng sập (Crash) ngay sau khi máy chủ trả `200 OK (COMMITTED)` | Khi khởi động lại, recovery đọc context, tiếp tục thực hiện SQLite rebind idempotent và dọn partition nguồn thành công. |
| **AC-05** | Ứng dụng sập khi SQLite transaction đang chạy dở dang | SQLite transaction tự rollback toàn bộ, không có dữ liệu chắp vá; recovery context giữ nguyên để thử lại. |
| **AC-06** | Ứng dụng sập sau khi SQLite commit xong nhưng chưa kịp xóa recovery context | Khi khởi động lại, kiểm tra idempotency của SQLite rebind, dọn dẹp an toàn và xóa recovery context, mở ACCOUNT. |
| **AC-07** | Người dùng chọn `KEEP_CLOUD` nhưng SQLite chưa từng cache progress của truyện đó | SQLite ghi đúng `conflict.cloudProgress` từ server vào `account:<userId>`, không bị null hoặc ghi đè sai. |
| **AC-08** | Server từ chối tiến độ đọc vì truyện đã có Tombstone trên Cloud | Quá trình rebind không tái sinh (resurrect) reading history hoặc progress của truyện đó vào `account:<userId>`. |
| **AC-09** | Gọi `/auth/me` gặp lỗi mạng tạm thời trong khi đang có recovery context | Không xem là logout, không rotate `guestProfileId`, giữ nguyên recovery context để khôi phục khi có mạng. |
| **AC-10** | Tài khoản A có pending claim, sau đó đăng xuất và đăng nhập Tài khoản B | Không áp dụng claim của Tài khoản A lên Tài khoản B. Phân định rạch ròi theo `pending.userId`. |
| **AC-11** | Sự cố thao tác tệp ngoại tuyến (nếu có) | Không gây gián đoạn hoặc xóa hỏng các gói chương tải offline của guest. |
| **AC-12** | Người dùng chủ động chọn "Bỏ qua" (Skip) | Thêm `guestProfileId` vào danh sách marker SharedPreferences, giữ nguyên 100% partition SQLite `guest:<guestProfileId>`, mở ACCOUNT. |

---

## 4. Kế Hoạch Triển Khai Tuần Tự (Phased Implementation Plan)

1. **Phase 1: Contracts Hardening & Recovery Models**
   - Triển khai `PendingGuestClaim` model, JSON serialization, `ClaimRecoveryPhase`.
   - Hardening `guest_claim_models.dart`: fail-closed `GuestClaimStatus.fromString()`, validate 64-char fingerprint, 1-based `pageIndex`.
2. **Phase 2: Identity Scope & Bridge Single Authority**
   - Cập nhật `ActiveScopeCoordinator`: `setTransitioning()`, `resolveToAccount()`, `deferScopeResolution`.
   - Cập nhật `AuthScopeBridge`: chuyển quyền quyết định mở account cho claim coordinator.
   - Cập nhật `AuthService`: bổ sung `register()` đồng bộ với auto-login semantics.
3. **Phase 3: Bootstrap Readiness & Shell Orchestration**
   - Tách biệt `bootstrapReady` khỏi `scopeResolved` trong `app/bootstrap.dart`.
   - Tạo `GuestClaimBottomSheet` (kèm `PopScope`, conflict comparator view, retry button).
   - Tích hợp listener điều phối tại tầng Root Shell.
4. **Phase 4: SQLite Transactional Rebind & Cloud Precedence**
   - Triển khai `hasGuestData(ownerScope)` (fail-closed).
   - Triển khai `rebindScope` trong `LocalLibraryDao` (atomic transaction, monotonic history, Cloud precedence progress).
5. **Phase 5: GuestClaimCoordinator Engine & Durable Crash Recovery**
   - Triển khai `GuestClaimCoordinator`: `checkAndPrepareClaim`, `confirmClaim`, `skipClaim`, `checkCrashRecovery`.
   - Lưu trữ `PendingGuestClaim` bền vững trước khi commit, xử lý 409 re-prepare, xử lý 5xx/timeout status check.
6. **Phase 6: Comprehensive Testing Suite & Regression Verification**
   - Unit tests cho Coordinator & Recovery State Machine.
   - Integration tests cho DAO Rebind (PK collision, rollback, monotonic MAX).
   - Widget tests cho BottomSheet (`PopScope`, conflict choice, error retry).
   - 12 Acceptance Scenarios verification + chạy full `flutter test` bảo đảm 410+ tests PASS 100%.
