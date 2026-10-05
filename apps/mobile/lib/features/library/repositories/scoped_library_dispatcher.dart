import '../../../core/auth/auth_service.dart';
import '../../../core/identity/active_scope_coordinator.dart';
import '../models/library_models.dart';
import 'account_library_adapter.dart';
import 'guest_library_adapter.dart';
import 'library_access.dart';

/// Lỗi định danh khi vi phạm Scope-Coherence Guard.
class ScopeCoherenceException implements Exception {
  final String message;
  const ScopeCoherenceException(this.message);

  @override
  String toString() => 'ScopeCoherenceException: $message';
}

/// Dispatcher điều phối [LibraryAccess] dựa trên Scope-Coherence Guard.
///
/// Invariant P0.4:
/// - Dispatch Account CHỈ KHI:
///     `auth.isAuthenticated` &&
///     `coordinator.activeScope == 'account:${auth.user?.id}'`
/// - Dispatch Guest CHỈ KHI:
///     `!auth.isAuthenticated` &&
///     `coordinator.activeScope.startsWith('guest:')`
/// - Mismatch, transitioning hoặc bootstrapping:
///     Mutation FAIL-CLOSED (ném [ScopeCoherenceException] hoặc [StateError]).
///     Read trả về safe fallback / empty snapshot.
class ScopedLibraryDispatcher implements LibraryAccess {
  final AuthService _authService;
  final ActiveScopeCoordinator _coordinator;
  final AccountLibraryAdapter _accountAdapter;
  final GuestLibraryAdapter _guestAdapter;

  ScopedLibraryDispatcher({
    required AuthService authService,
    required ActiveScopeCoordinator coordinator,
    required AccountLibraryAdapter accountAdapter,
    required GuestLibraryAdapter guestAdapter,
  })  : _authService = authService,
        _coordinator = coordinator,
        _accountAdapter = accountAdapter,
        _guestAdapter = guestAdapter;

  bool _isAccountCoherent() {
    final auth = _authService.state;
    final activeScope = _coordinator.activeScope;
    final userId = auth.user?.id;
    return auth.isAuthenticated &&
        userId != null &&
        userId.isNotEmpty &&
        activeScope == 'account:$userId';
  }

  bool _isGuestCoherent() {
    final auth = _authService.state;
    final activeScope = _coordinator.activeScope;
    return !auth.isAuthenticated &&
        activeScope != null &&
        activeScope.startsWith('guest:') &&
        activeScope.length > 6;
  }

  void _assertMutationAllowed() {
    if (_isAccountCoherent() || _isGuestCoherent()) {
      return;
    }
    throw ScopeCoherenceException(
      'Không thể thực hiện mutation thư viện khi trạng thái scope không nhất quán: '
      'auth.isAuthenticated=${_authService.state.isAuthenticated}, '
      'activeScope=${_coordinator.activeScope}.',
    );
  }

  @override
  Future<BookmarkStatusResponse> getBookmarkStatus(String storyId) async {
    if (_isAccountCoherent()) {
      return _accountAdapter.getBookmarkStatus(storyId);
    }
    if (_isGuestCoherent()) {
      return _guestAdapter.getBookmarkStatus(storyId);
    }
    // Safe read fallback
    return const BookmarkStatusResponse(isBookmarked: false);
  }

  @override
  Future<BookmarkStatusResponse> setBookmark(BookmarkMutation mutation) async {
    _assertMutationAllowed();
    if (_isAccountCoherent()) {
      return _accountAdapter.setBookmark(mutation);
    }
    return _guestAdapter.setBookmark(mutation);
  }

  @override
  List<BookmarkedStoryItem> getCachedBookmarks({String? status}) {
    if (_isAccountCoherent()) {
      return _accountAdapter.getCachedBookmarks(status: status);
    }
    if (_isGuestCoherent()) {
      return _guestAdapter.getCachedBookmarks(status: status);
    }
    return const [];
  }

  @override
  Future<PaginatedBookmarksResponse> fetchBookmarks({
    int page = 1,
    int limit = 20,
    String? status,
  }) async {
    if (_isAccountCoherent()) {
      return _accountAdapter.fetchBookmarks(page: page, limit: limit, status: status);
    }
    if (_isGuestCoherent()) {
      return _guestAdapter.fetchBookmarks(page: page, limit: limit, status: status);
    }
    return PaginatedBookmarksResponse(
      data: const [],
      pagination: PaginationMeta(page: page, limit: limit, totalItems: 0, totalPages: 1),
    );
  }

  @override
  List<ReadingHistoryItem> getCachedHistory() {
    if (_isAccountCoherent()) {
      return _accountAdapter.getCachedHistory();
    }
    if (_isGuestCoherent()) {
      return _guestAdapter.getCachedHistory();
    }
    return const [];
  }

  @override
  Future<PaginatedReadingHistoryResponse> fetchHistory({
    int page = 1,
    int limit = 20,
    bool updateCache = true,
  }) async {
    if (_isAccountCoherent()) {
      return _accountAdapter.fetchHistory(page: page, limit: limit, updateCache: updateCache);
    }
    if (_isGuestCoherent()) {
      return _guestAdapter.fetchHistory(page: page, limit: limit, updateCache: updateCache);
    }
    return PaginatedReadingHistoryResponse(
      data: const [],
      pagination: PaginationMeta(page: page, limit: limit, totalItems: 0, totalPages: 1),
    );
  }

  @override
  ReadingHistoryItem? getCachedContinueReading() {
    if (_isAccountCoherent()) {
      return _accountAdapter.getCachedContinueReading();
    }
    if (_isGuestCoherent()) {
      return _guestAdapter.getCachedContinueReading();
    }
    return null;
  }

  @override
  Future<ReadingHistoryItem?> getContinueReading() async {
    if (_isAccountCoherent()) {
      return _accountAdapter.getContinueReading();
    }
    if (_isGuestCoherent()) {
      return _guestAdapter.getContinueReading();
    }
    return null;
  }

  @override
  Future<void> deleteStoryHistory(String storyId) async {
    _assertMutationAllowed();
    if (_isAccountCoherent()) {
      return _accountAdapter.deleteStoryHistory(storyId);
    }
    return _guestAdapter.deleteStoryHistory(storyId);
  }

  @override
  Future<void> clearAllHistory() async {
    _assertMutationAllowed();
    if (_isAccountCoherent()) {
      return _accountAdapter.clearAllHistory();
    }
    return _guestAdapter.clearAllHistory();
  }
}
