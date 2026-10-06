# Task 7A.6 Step 2 — Explicit Router Policy + Scope-Safe UI Repository Ports + Runtime Guest/Account Dispatch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triển khai Explicit Route Policy, UI-facing Port/Adapter pattern cho Library và Reading Progress, Scope-Coherence Guard chống race condition lúc transition, và nút "Tiếp tục với tư cách Khách" trên Mobile.

**Architecture:** Thay thế concrete class inheritance bằng mô hình UI-facing Port + Account Adapter + Guest Adapter + Scoped Dispatcher. Đảm bảo Scope-Coherence Guard (chỉ cho phép dispatch khi cả `AuthService` và `ActiveScopeCoordinator` đồng thuận 100%, mismatch/transitioning sẽ fail-closed đối với mọi mutation). Đồng thời áp dụng Explicit Route Whitelist trong GoRouter, tách biệt route access khỏi action authorization.

**Tech Stack:** Flutter / Dart, GoRouter 14+, SQLite v3 (`sqflite_common_ffi` / `OfflineDatabase`), `ActiveScopeCoordinator`, `AuthScopeBridge`, `SharedPreferences`.

## Global Constraints

- **Scope Coherence Guard (P0):**
  - Account dispatch yêu cầu: `auth == authenticated` && `coordinator.activeScope == 'account:${userId}'`.
  - Guest dispatch yêu cầu: `auth == unauthenticated` && `coordinator.activeScope.startsWith('guest:')`.
  - Mismatch, transitioning hoặc bootstrapping: **fail-closed** đối với mọi mutation (`StateError`).
- **Metadata-Rich Bookmarks (P0):** `BookmarkMutation` mang đủ `storyId`, `isBookmarked`, `title`, `slug`, `coverUrl`. Account gửi API, Guest ghi trực tiếp `LocalBookmark`.
- **Zero-Server-Semantics for Guest Reader (P0):** Guest Reader ghi thẳng `LocalReadingProgress` + `LocalReadingHistory` vào SQLite qua `GuestReadingProgressRepository.recordReadingSession()`, zero server epoch, zero fake responses, zero HTTP PUT.
- **Explicit Route Whitelist (P0):** Public whitelist gồm `/home`, `/search`, `/library`, `/story/:slug`, `/reader/:chapterId`, `/login`. Account-only gồm `/profile`. Route lạ để GoRouter tự xử lý 404 (không redirect sang `/login`).
- **Deterministic Navigation (P0):**
  - Logout khi đang ở `/profile` -> rotate sang `guest:<new_G>` -> redirect `/home`.
  - Login thất bại từ `/login?returnTo=X` -> giữ nguyên `guest:<old_G>`, giữ nguyên vị trí `/login?returnTo=X`.
- **Continuous Commit:** Mỗi Task hoàn thành độc lập kèm kiểm thử xác minh và commit git.

---

### Task 1: Library Access Port, Adapters & Scoped Dispatcher with Scope-Coherence Guard

**Files:**
- Create: `apps/mobile/lib/features/library/repositories/library_access.dart`
- Create: `apps/mobile/lib/features/library/repositories/account_library_adapter.dart`
- Create: `apps/mobile/lib/features/library/repositories/guest_library_adapter.dart`
- Create: `apps/mobile/lib/features/library/repositories/scoped_library_dispatcher.dart`
- Test: `apps/mobile/test/features/library/scoped_library_dispatcher_test.dart`

**Interfaces:**
- Consumes: `LibraryRepository`, `GuestLibraryRepository`, `ActiveScopeCoordinator`, `AuthService`.
- Produces: `LibraryAccess`, `BookmarkMutation`, `AccountLibraryAdapter`, `GuestLibraryAdapter`, `ScopedLibraryDispatcher`.

- [x] **Step 1: Viết test cho LibraryAccess Port, Guest/Account Adapters và Scope-Coherence Guard**

```dart
// test/features/library/scoped_library_dispatcher_test.dart
// Kiểm tra:
// 1. Scope Coherence: auth=unauthenticated & coordinator=guest:<G> -> dispatch guest adapter, ghi SQLite
// 2. Scope Coherence: auth=authenticated & coordinator=account:<U> -> dispatch account adapter, gọi LibraryRepository
// 3. Fail-Closed: auth=unauthenticated nhưng coordinator vẫn còn account:<U> (race condition) -> mutation ném StateError
// 4. Fail-Closed: coordinator=bootstrapping -> mutation ném StateError
// 5. BookmarkMutation chuyển đủ title/slug/coverUrl vào LocalBookmark của SQLite
```

- [x] **Step 2: Chạy test để xác nhận FAIL (chưa có class)**

Run: `flutter test test/features/library/scoped_library_dispatcher_test.dart`
Expected: FAIL (File not found / Compilation errors)

- [x] **Step 3: Triển khai `LibraryAccess` Port và `BookmarkMutation`**

File: `apps/mobile/lib/features/library/repositories/library_access.dart`
```dart
abstract class LibraryAccess {
  Future<BookmarkStatusResponse> getBookmarkStatus(String storyId);
  Future<BookmarkStatusResponse> setBookmark(BookmarkMutation mutation);
  List<BookmarkedStoryItem> getCachedBookmarks({String? status});
  Future<PaginatedBookmarksResponse> fetchBookmarks({int page = 1, int limit = 20, String? status});
  List<ReadingHistoryItem> getCachedHistory();
  Future<PaginatedReadingHistoryResponse> fetchHistory({int page = 1, int limit = 20, bool updateCache = true});
  ReadingHistoryItem? getCachedContinueReading();
  Future<ReadingHistoryItem?> getContinueReading();
  Future<void> deleteStoryHistory(String storyId);
  Future<void> clearAllHistory();
}
```

- [x] **Step 4: Triển khai `AccountLibraryAdapter` và `GuestLibraryAdapter`**

File: `apps/mobile/lib/features/library/repositories/account_library_adapter.dart`
- Chuyển tiếp các method sang `LibraryRepository`.
- `setBookmark(mutation)` gọi `_repository.setBookmark(mutation.storyId, mutation.isBookmarked)`.

File: `apps/mobile/lib/features/library/repositories/guest_library_adapter.dart`
- Chuyển tiếp các method sang `GuestLibraryRepository`.
- `setBookmark(mutation)`: nếu `mutation.isBookmarked`, gọi `_guestRepo.saveBookmark(storyId: mutation.storyId, title: mutation.title, slug: mutation.slug, coverUrl: mutation.coverUrl)`; nếu false, gọi `_guestRepo.deleteBookmark(mutation.storyId)`.
- Chuyển đổi DTO `LocalBookmark` -> `BookmarkedStoryItem`, `LocalReadingHistory` -> `ReadingHistoryItem`.

- [x] **Step 5: Triển khai `ScopedLibraryDispatcher` với Scope-Coherence Guard**

File: `apps/mobile/lib/features/library/repositories/scoped_library_dispatcher.dart`
- Kiểm tra tính nhất quán giữa `authService.state` và `coordinator.activeScope`.
- Nếu mismatch hoặc unresolved: read trả về empty snapshot an toàn, mutation ném `StateError('Scope coherence violation')`.

- [x] **Step 6: Chạy lại test xác nhận PASS**

Run: `flutter test test/features/library/scoped_library_dispatcher_test.dart`
Expected: PASS (All tests passed)

- [x] **Step 7: Commit Task 1**

```bash
git add apps/mobile/lib/features/library/repositories/ apps/mobile/test/features/library/
git commit -m "feat(mobile): implement LibraryAccess port, adapters and ScopedLibraryDispatcher with coherence guard"
```

---

### Task 2: Reading Session Access Port, Guest Reader Session & Scoped Dispatcher

**Files:**
- Create: `apps/mobile/lib/features/reader/repositories/reading_session_access.dart`
- Create: `apps/mobile/lib/features/reader/repositories/account_reading_session_adapter.dart`
- Create: `apps/mobile/lib/features/reader/repositories/guest_reading_session_adapter.dart`
- Create: `apps/mobile/lib/features/reader/repositories/scoped_reading_session_dispatcher.dart`
- Test: `apps/mobile/test/features/reader/scoped_reading_session_dispatcher_test.dart`

**Interfaces:**
- Consumes: `GuestReadingProgressRepository`, `ReadingProgressRepository`, `ActiveScopeCoordinator`, `AuthService`.
- Produces: `ReadingSessionAccess`, `ScopedReadingSessionDispatcher`.

- [x] **Step 1: Viết test cho ReadingSessionAccess và Guest/Account Session Adapters**

```dart
// test/features/reader/scoped_reading_session_dispatcher_test.dart
// Kiểm tra:
// 1. Guest reader session: recordProgress ghi trực tiếp vào SQLite v3 (local_reading_progress + local_reading_history)
// 2. Zero network & Zero server epoch cho guest session
// 3. Metadata điền đủ: storyTitle, storySlug, storyCoverUrl, chapterNumber, chapterTitle
// 4. Account session: sử dụng ReadingProgressRepository / coordinator chuẩn
// 5. Coherence Guard: mismatch hoặc bootstrapping -> mutation fail-closed
```

- [x] **Step 2: Chạy test để xác nhận FAIL**

Run: `flutter test test/features/reader/scoped_reading_session_dispatcher_test.dart`
Expected: FAIL

- [x] **Step 3: Triển khai `ReadingSessionAccess` Port**

File: `apps/mobile/lib/features/reader/repositories/reading_session_access.dart`
```dart
abstract class ReadingSessionAccess {
  Future<void> initSession({required String storyId});
  void recordProgress({
    required String storyId,
    required String chapterId,
    String? chapterVersionId,
    String readingMode,
    required int flutterPageIndex,
    required double progressPercentage,
    required double scrollPosition,
    String? anchorBlockId,
    int? textOffset,
    String? storyTitle,
    String? storySlug,
    String? storyCoverUrl,
    String? chapterNumber,
    String? chapterTitle,
  });
  void flush();
  void dispose();
}
```

- [x] **Step 4: Triển khai `GuestReadingSessionAdapter`**

File: `apps/mobile/lib/features/reader/repositories/guest_reading_session_adapter.dart`
- Debounce 1500ms tương tự coordinator nhưng ghi thẳng `_guestRepo.recordReadingSession(...)` với `LocalReadingProgress` và `LocalReadingHistory`.
- Tuyệt đối không gọi `ensureServerEpoch`, không HTTP PUT, không gamification.

- [x] **Step 5: Triển khai `AccountReadingSessionAdapter` và `ScopedReadingSessionDispatcher`**

File: `apps/mobile/lib/features/reader/repositories/account_reading_session_adapter.dart`
File: `apps/mobile/lib/features/reader/repositories/scoped_reading_session_dispatcher.dart`
- Dispatcher kiểm tra scope-coherence trước khi gọi adapter tương ứng.

- [x] **Step 6: Chạy lại test xác nhận PASS**

Run: `flutter test test/features/reader/scoped_reading_session_dispatcher_test.dart`
Expected: PASS

- [x] **Step 7: Commit Task 2**

```bash
git add apps/mobile/lib/features/reader/repositories/ apps/mobile/test/features/reader/
git commit -m "feat(mobile): implement ReadingSessionAccess port, guest adapter and ScopedReadingSessionDispatcher"
```

---

### Task 3: UI Adaptation for Screens (`StoryDetailScreen`, `ReaderScreen`, `LibraryScreen`, `HomeScreen`)

**Files:**
- Modify: `apps/mobile/lib/features/story/presentation/story_detail_screen.dart`
- Modify: `apps/mobile/lib/features/reader/presentation/reader_screen.dart`
- Modify: `apps/mobile/lib/features/library/presentation/library_screen.dart`
- Modify: `apps/mobile/lib/features/home/presentation/home_screen.dart`
- Modify: `apps/mobile/lib/features/auth/presentation/login_screen.dart`
- Test: Cập nhật widget tests hiện tại của các màn hình để verify tương thích `LibraryAccess` và metadata mutation.

**Interfaces:**
- Screens nhận `LibraryAccess` thay vì concrete `LibraryRepository`.
- `ReaderScreen` sử dụng `ReadingSessionAccess` hoặc coordinator tương thích cho Guest.
- `LoginScreen` có nút "Tiếp tục với tư cách Khách" (`Key('login_continue_as_guest_button')`).

- [x] **Step 1: Cập nhật `LoginScreen` thêm nút "Tiếp tục với tư cách Khách"**

File: `apps/mobile/lib/features/auth/presentation/login_screen.dart`
- Thêm `OutlinedButton` / `TextButton` với text "Tiếp tục với tư cách Khách" và key `login_continue_as_guest_button`.
- `onPressed: () => context.go('/home')`.

- [x] **Step 2: Cập nhật `LibraryScreen` & `HomeScreen` nhận `LibraryAccess`**

File: `apps/mobile/lib/features/library/presentation/library_screen.dart`
File: `apps/mobile/lib/features/home/presentation/home_screen.dart`
- Đổi kiểu tham số từ `LibraryRepository` thành `LibraryAccess`. Mọi method call giữ nguyên tên.

- [x] **Step 3: Cập nhật `StoryDetailScreen` dùng `BookmarkMutation` mang đủ metadata**

File: `apps/mobile/lib/features/story/presentation/story_detail_screen.dart`
- Trong `_toggleBookmark()`:
```dart
await libraryAccess.setBookmark(
  BookmarkMutation(
    storyId: _story!.id,
    isBookmarked: newStatus,
    title: _story!.title,
    slug: _story!.slug,
    coverUrl: _story!.coverUrl,
  ),
);
```

- [x] **Step 4: Cập nhật `ReaderScreen` truyền metadata vào session và ngắt gamification khi Guest**

File: `apps/mobile/lib/features/reader/presentation/reader_screen.dart`
- Khi ghi tiến độ, truyền thêm `storyTitle`, `storySlug`, `storyCoverUrl`, `chapterNumber`, `chapterTitle`.
- Kiểm tra `authService.state.isAuthenticated`: nếu false, không khởi tạo gamification reward listener.

- [x] **Step 5: Chạy lại test của các features để kiểm tra regressions**

Run: `flutter test test/features/auth/login_screen_test.dart`
Run: `flutter test test/features/library/library_screen_test.dart`
Expected: PASS

- [x] **Step 6: Commit Task 3**

```bash
git add apps/mobile/lib/features/ apps/mobile/test/features/
git commit -m "feat(mobile): adapt UI screens to LibraryAccess port, metadata bookmarks, and continue as guest"
```

---

### Task 4: Explicit Router Policy & AppBootstrap Wiring

**Files:**
- Modify: `apps/mobile/lib/app/router/app_router.dart`
- Modify: `apps/mobile/lib/app/bootstrap.dart`
- Test: Create `apps/mobile/test/app/router/app_router_scope_test.dart`

**Interfaces:**
- `AppRouter.create()` nhận `ActiveScopeCoordinator`, `GuestLibraryRepository`, `GuestReadingProgressRepository`, `AuthService`, `ApiClient`.
- Router khởi tạo `ScopedLibraryDispatcher` và `ScopedReadingSessionDispatcher` để truyền vào các route.

- [x] **Step 1: Viết test suite bao phủ trọn vẹn 13 Acceptance Cases**

File: `apps/mobile/test/app/router/app_router_scope_test.dart`
Bao gồm:
1. `cold guest boot` -> `/home`, không redirect `/login`.
2. `guest -> /library` -> vào thành công, đọc SQLite.
3. `guest deep-link /story/foo` -> vào thành công.
4. `guest deep-link /reader/chapter-1` -> vào thành công.
5. `guest -> /search` -> vào thành công.
6. `guest -> /profile` -> bị chặn, redirect `/login?returnTo=%2Fprofile`.
7. `authenticated account -> /login` -> redirect `/home` (hoặc `returnTo` nếu có).
8. `login fail` tại `/login?returnTo=X` -> giữ nguyên `guest:<old_G>`, giữ nguyên vị trí `/login?returnTo=X`.
9. `logout` tại `/profile` -> rotate sang `guest:<new_G>`, redirect deterministic về `/home`.
10. `logout` tại `/library` -> route giữ nguyên, repository chuyển sang `guest:<new_G>` rỗng hoàn toàn.
11. `guest library mutation` -> chỉ ghi SQLite `owner_scope = guest:<G>`, zero API.
12. `account library/progress mutation` -> chỉ ghi API / Account Cache, không bao giờ chạm `guest:<G>`.
13. `bootstrapping` / scope unresolved -> mutation ném `StateError` (fail-closed).

- [x] **Step 2: Chạy test để xác nhận FAIL**

Run: `flutter test test/app/router/app_router_scope_test.dart`
Expected: FAIL

- [x] **Step 3: Cập nhật `AppRouter.create()` với Explicit Route Whitelist & returnTo**

File: `apps/mobile/lib/app/router/app_router.dart`
- Nhận `ActiveScopeCoordinator`, wire `ScopedLibraryDispatcher` và `ScopedReadingSessionDispatcher`.
- Cấu hình redirect:
```dart
redirect: (BuildContext context, GoRouterState state) {
  final authState = authService.state;
  final location = state.matchedLocation;
  final isLoggingIn = location == '/login';

  if (authState.status == AuthStatus.initial) return null;

  if (authState.isAuthenticated) {
    if (isLoggingIn) {
      final returnTo = state.uri.queryParameters['returnTo'];
      if (returnTo != null && returnTo.isNotEmpty && returnTo.startsWith('/') && returnTo != '/login') {
        return returnTo;
      }
      return '/home';
    }
    return null;
  }

  // Guest Policy
  if (location == '/profile' || location.startsWith('/profile/')) {
    final returnTo = Uri.encodeComponent(state.uri.toString());
    return '/login?returnTo=$returnTo';
  }

  // Explicit Public Whitelist
  final isPublic = location == '/home' ||
      location == '/search' ||
      location == '/library' ||
      location == '/login' ||
      location.startsWith('/story/') ||
      location.startsWith('/reader/');

  if (isPublic) return null;

  // Unknown route -> để GoRouter tự xử lý (không ép về /login)
  return null;
}
```

- [x] **Step 4: Cập nhật `AppBootstrap.run()` truyền Scope & Guest Repositories**

File: `apps/mobile/lib/app/bootstrap.dart`
- Truyền `activeScopeCoordinator`, `guestLibraryRepository`, `guestReadingProgressRepository` vào `AppRouter.create(...)`.

- [x] **Step 5: Chạy lại toàn bộ test suite Router & Scope**

Run: `flutter test test/app/router/app_router_scope_test.dart`
Expected: PASS (13/13 tests passed)

- [x] **Step 6: Chạy test suite toàn app `apps/mobile` để bảo đảm zero regression**

Run: `flutter test`
Expected: All tests passed

- [x] **Step 7: Commit & Push Task 4**

```bash
git add apps/mobile/lib/ apps/mobile/test/ plans/
git commit -m "feat(mobile): wire Scoped dispatchers to AppRouter and pass all 13 acceptance cases for Task 7A.6 Step 2"
git push origin main
```

---

## 🔒 Frozen Status Signoff (Task 7A.6 Step 2 — CLOSED / FROZEN CLEAN)

> **Official Baseline Commit:** `903d7182aacbf9fcbe1875c0a51db54823a9f026`  
> **Acceptance Suite:** 19/19 cases passed in `test/app/router/task4_acceptance_matrix_test.dart`  
> **App-wide Suite:** 398/398 passed in `apps/mobile`  
> **Linter:** `flutter analyze` — 0 issues found  
> **Contract Status:** FROZEN CONTRACT — Closed to modifications unless formal regression evidence arises.

### Frozen Invariant Matrix:
- **Identity Isolation:** `AuthScopeBridge` + deterministic fresh guest rotation on logout / cold start.
- **Write Dispatch:** Abstract `LibraryAccess` & `ReadingSessionAccess` with 4-tuple coherence check.
- **Read Dispatch:** Neutral `ReadingStateAccess` with `ScopedReadingStateDispatcher` & `GuestReadingStateAdapter`.
- **Coherence Guard:** `AuthStatus + ActiveScopeState + activeScope + userId` verified; mismatch / transition fail-closed.
- **Deferred Side Effects:** Reader debounce cancellation immediately executed on scope change / logout.
- **Async UI Reads (Task 4c):** Generation + scope-token invalidation across `StoryDetailScreen`, `LibraryScreen`, and `HomeScreen`.
- **Guest Persistence:** Local SQLite partition strictly isolated by `owner_scope = guest:<G>`, zero network/bearer leakage.
- **Account Persistence:** Server API + Account Cache, zero fallback into guest storage.
- **Transition States:** Fail-closed against any read/write mutations.

