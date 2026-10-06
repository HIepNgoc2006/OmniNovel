import '../../../core/auth/auth_service.dart';
import '../../../core/auth/auth_state.dart';
import '../../../core/identity/active_scope_coordinator.dart';
import '../models/story_reading_state.dart';
import 'reading_state_access.dart';

/// Dispatcher điều phối [ReadingStateAccess] dựa trên Scope-Coherence Guard (4-tuple guard).
///
/// Invariant P0.4:
/// - Dispatch Account CHỈ KHI:
///     `auth.status == AuthStatus.authenticated` &&
///     `coordinator.state == ActiveScopeState.account` &&
///     `coordinator.activeScope == 'account:${auth.user?.id}'`
/// - Dispatch Guest CHỈ KHI:
///     `auth.status == AuthStatus.unauthenticated` &&
///     `coordinator.state == ActiveScopeState.guest` &&
///     `coordinator.activeScope.startsWith('guest:')`
/// - Mismatch, transitioning hoặc bootstrapping:
///     Trả về safe fallback (empty state, zero network, zero leakage).
class ScopedReadingStateDispatcher implements ReadingStateAccess {
  final AuthService _authService;
  final ActiveScopeCoordinator _coordinator;
  final ReadingStateAccess _accountAdapter;
  final ReadingStateAccess _guestAdapter;

  ScopedReadingStateDispatcher({
    required AuthService authService,
    required ActiveScopeCoordinator coordinator,
    required ReadingStateAccess accountAdapter,
    required ReadingStateAccess guestAdapter,
  })  : _authService = authService,
        _coordinator = coordinator,
        _accountAdapter = accountAdapter,
        _guestAdapter = guestAdapter;

  bool _isAccountCoherent() {
    final auth = _authService.state;
    final activeScope = _coordinator.activeScope;
    final coordState = _coordinator.state;
    final userId = auth.user?.id.trim();

    return auth.status == AuthStatus.authenticated &&
        coordState == ActiveScopeState.account &&
        userId != null &&
        userId.isNotEmpty &&
        activeScope == 'account:$userId';
  }

  bool _isGuestCoherent() {
    final auth = _authService.state;
    final activeScope = _coordinator.activeScope;
    final coordState = _coordinator.state;

    return auth.status == AuthStatus.unauthenticated &&
        coordState == ActiveScopeState.guest &&
        activeScope != null &&
        activeScope.startsWith('guest:') &&
        activeScope.length > 6;
  }

  @override
  Future<StoryReadingState> getStoryReadingState(String storyId) async {
    if (_isAccountCoherent()) {
      return _accountAdapter.getStoryReadingState(storyId);
    }
    if (_isGuestCoherent()) {
      return _guestAdapter.getStoryReadingState(storyId);
    }
    // Fail-closed read fallback: empty state, zero network calls, zero identity leakage
    return const StoryReadingState(
      resume: null,
      readChapterIds: <String>{},
    );
  }
}
