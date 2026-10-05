import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/library/models/library_models.dart';
import 'package:omninovel_mobile/features/library/repositories/account_library_adapter.dart';
import 'package:omninovel_mobile/features/library/repositories/guest_library_adapter.dart';
import 'package:omninovel_mobile/features/library/repositories/library_access.dart';
import 'package:omninovel_mobile/features/library/repositories/scoped_library_dispatcher.dart';

class MockAuthService extends Mock implements AuthService {}
class MockCoordinator extends Mock implements ActiveScopeCoordinator {}
class MockAccountAdapter extends Mock implements AccountLibraryAdapter {}
class MockGuestAdapter extends Mock implements GuestLibraryAdapter {}

void main() {
  group('Task 2: ScopedLibraryDispatcher & Scope-Coherence Guard', () {
    late MockAuthService mockAuth;
    late MockCoordinator mockCoordinator;
    late MockAccountAdapter mockAccountAdapter;
    late MockGuestAdapter mockGuestAdapter;
    late ScopedLibraryDispatcher dispatcher;

    setUp(() {
      mockAuth = MockAuthService();
      mockCoordinator = MockCoordinator();
      mockAccountAdapter = MockAccountAdapter();
      mockGuestAdapter = MockGuestAdapter();

      dispatcher = ScopedLibraryDispatcher(
        authService: mockAuth,
        coordinator: mockCoordinator,
        accountAdapter: mockAccountAdapter,
        guestAdapter: mockGuestAdapter,
      );
    });

    test('1. Coherent Account: dispatches mutations and reads to AccountLibraryAdapter only', () async {
      when(() => mockAuth.state).thenReturn(
        AuthState(
          status: AuthStatus.authenticated,
          user: const User(id: 'usr-123', email: 'u@test.com', username: 'usr123', role: 'READER'),
        ),
      );
      when(() => mockCoordinator.activeScope).thenReturn('account:usr-123');

      const mutation = BookmarkMutation(storyId: 's1', isBookmarked: true, title: 'T1');
      when(() => mockAccountAdapter.setBookmark(mutation))
          .thenAnswer((_) async => const BookmarkStatusResponse(isBookmarked: true));
      when(() => mockAccountAdapter.getBookmarkStatus('s1'))
          .thenAnswer((_) async => const BookmarkStatusResponse(isBookmarked: true));

      final res = await dispatcher.setBookmark(mutation);
      expect(res.isBookmarked, isTrue);

      final status = await dispatcher.getBookmarkStatus('s1');
      expect(status.isBookmarked, isTrue);

      verify(() => mockAccountAdapter.setBookmark(mutation)).called(1);
      verify(() => mockAccountAdapter.getBookmarkStatus('s1')).called(1);
      verifyZeroInteractions(mockGuestAdapter); // Invariant: Zero guest touch
    });

    test('2. Coherent Guest: dispatches mutations and reads to GuestLibraryAdapter only', () async {
      when(() => mockAuth.state).thenReturn(AuthState.unauthenticated());
      when(() => mockCoordinator.activeScope).thenReturn('guest:gst-xyz-789');

      const mutation = BookmarkMutation(storyId: 's2', isBookmarked: true, title: 'T2');
      when(() => mockGuestAdapter.setBookmark(mutation))
          .thenAnswer((_) async => const BookmarkStatusResponse(isBookmarked: true));
      when(() => mockGuestAdapter.getBookmarkStatus('s2'))
          .thenAnswer((_) async => const BookmarkStatusResponse(isBookmarked: true));

      final res = await dispatcher.setBookmark(mutation);
      expect(res.isBookmarked, isTrue);

      final status = await dispatcher.getBookmarkStatus('s2');
      expect(status.isBookmarked, isTrue);

      verify(() => mockGuestAdapter.setBookmark(mutation)).called(1);
      verify(() => mockGuestAdapter.getBookmarkStatus('s2')).called(1);
      verifyZeroInteractions(mockAccountAdapter); // Invariant: Zero account touch
    });

    test('3. Race / Mismatch Guard (Auth unauthenticated nhưng Coordinator còn account:U): Fail-Closed on mutation', () async {
      when(() => mockAuth.state).thenReturn(AuthState.unauthenticated());
      when(() => mockCoordinator.activeScope).thenReturn('account:usr-123'); // Mismatch!

      const mutation = BookmarkMutation(storyId: 's3', isBookmarked: true, title: 'T3');

      // Mutation MUST fail closed
      expect(
        () => dispatcher.setBookmark(mutation),
        throwsA(isA<ScopeCoherenceException>()),
      );
      expect(
        () => dispatcher.deleteStoryHistory('s3'),
        throwsA(isA<ScopeCoherenceException>()),
      );
      expect(
        () => dispatcher.clearAllHistory(),
        throwsA(isA<ScopeCoherenceException>()),
      );

      // Read fallback safe empty
      final status = await dispatcher.getBookmarkStatus('s3');
      expect(status.isBookmarked, isFalse);

      verifyZeroInteractions(mockAccountAdapter);
      verifyZeroInteractions(mockGuestAdapter);
    });

    test('4. Bootstrapping / Unresolved scope: Fail-Closed on mutation', () async {
      when(() => mockAuth.state).thenReturn(AuthState.initial());
      when(() => mockCoordinator.activeScope).thenReturn(null); // Unresolved!

      const mutation = BookmarkMutation(storyId: 's4', isBookmarked: true, title: 'T4');

      expect(
        () => dispatcher.setBookmark(mutation),
        throwsA(isA<ScopeCoherenceException>()),
      );

      verifyZeroInteractions(mockAccountAdapter);
      verifyZeroInteractions(mockGuestAdapter);
    });
  });
}
