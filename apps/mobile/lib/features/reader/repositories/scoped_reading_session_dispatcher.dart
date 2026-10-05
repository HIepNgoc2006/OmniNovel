import '../../../core/auth/auth_service.dart';
import '../../../core/identity/active_scope_coordinator.dart';
import '../../library/repositories/scoped_library_dispatcher.dart';
import 'account_reading_session_adapter.dart';
import 'guest_reading_session_adapter.dart';
import 'reading_session_access.dart';

/// Dispatcher điều phối [ReadingSessionAccess] dựa trên Scope-Coherence Guard.
///
/// Invariant P0.4:
/// - Dispatch Account CHỈ KHI:
///     `auth.isAuthenticated` &&
///     `coordinator.activeScope == 'account:${auth.user?.id}'`
/// - Dispatch Guest CHỈ KHI:
///     `!auth.isAuthenticated` &&
///     `coordinator.activeScope.startsWith('guest:')`
/// - Mismatch, transitioning hoặc bootstrapping:
///     Mutation FAIL-CLOSED (ném [ScopeCoherenceException]).
class ScopedReadingSessionDispatcher implements ReadingSessionAccess {
  final AuthService _authService;
  final ActiveScopeCoordinator _coordinator;
  final AccountReadingSessionAdapter _accountAdapter;
  final GuestReadingSessionAdapter _guestAdapter;

  ScopedReadingSessionDispatcher({
    required AuthService authService,
    required ActiveScopeCoordinator coordinator,
    required AccountReadingSessionAdapter accountAdapter,
    required GuestReadingSessionAdapter guestAdapter,
  })  : _authService = authService,
        _coordinator = coordinator,
        _accountAdapter = accountAdapter,
        _guestAdapter = guestAdapter {
    _coordinator.addListener(_onScopeChanged);
    _authService.addListener(_onScopeChanged);
  }

  void _onScopeChanged() {
    // Invariant: No deferred side effect may outlive the scope under which it was scheduled
    if (!_isAccountCoherent()) {
      _accountAdapter.cancelPendingEffects();
    }
    if (!_isGuestCoherent()) {
      _guestAdapter.cancelPendingEffects();
    }
  }

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
      'Không thể ghi nhận tiến độ đọc khi trạng thái scope không nhất quán: '
      'auth.isAuthenticated=${_authService.state.isAuthenticated}, '
      'activeScope=${_coordinator.activeScope}.',
    );
  }

  @override
  Future<void> initSession({required String storyId}) async {
    if (_isAccountCoherent()) {
      await _accountAdapter.initSession(storyId: storyId);
    } else if (_isGuestCoherent()) {
      await _guestAdapter.initSession(storyId: storyId);
    }
  }

  @override
  void recordProgress({
    required String storyId,
    required String chapterId,
    String? chapterVersionId,
    String readingMode = 'WEBTOON',
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
  }) {
    _assertMutationAllowed();
    if (_isAccountCoherent()) {
      _accountAdapter.recordProgress(
        storyId: storyId,
        chapterId: chapterId,
        chapterVersionId: chapterVersionId,
        readingMode: readingMode,
        flutterPageIndex: flutterPageIndex,
        progressPercentage: progressPercentage,
        scrollPosition: scrollPosition,
        anchorBlockId: anchorBlockId,
        textOffset: textOffset,
        storyTitle: storyTitle,
        storySlug: storySlug,
        storyCoverUrl: storyCoverUrl,
        chapterNumber: chapterNumber,
        chapterTitle: chapterTitle,
      );
    } else {
      _guestAdapter.recordProgress(
        storyId: storyId,
        chapterId: chapterId,
        chapterVersionId: chapterVersionId,
        readingMode: readingMode,
        flutterPageIndex: flutterPageIndex,
        progressPercentage: progressPercentage,
        scrollPosition: scrollPosition,
        anchorBlockId: anchorBlockId,
        textOffset: textOffset,
        storyTitle: storyTitle,
        storySlug: storySlug,
        storyCoverUrl: storyCoverUrl,
        chapterNumber: chapterNumber,
        chapterTitle: chapterTitle,
      );
    }
  }

  @override
  Future<void> flush() async {
    if (_isAccountCoherent()) {
      await _accountAdapter.flush();
    } else if (_isGuestCoherent()) {
      await _guestAdapter.flush();
    }
  }

  @override
  void dispose() {
    _coordinator.removeListener(_onScopeChanged);
    _authService.removeListener(_onScopeChanged);
    _accountAdapter.dispose();
    _guestAdapter.dispose();
  }
}
