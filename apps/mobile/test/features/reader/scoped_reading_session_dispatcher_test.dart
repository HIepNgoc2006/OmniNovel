import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/library/repositories/scoped_library_dispatcher.dart';
import 'package:omninovel_mobile/features/reader/repositories/account_reading_session_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_session_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/scoped_reading_session_dispatcher.dart';

class MockAuthService extends Mock implements AuthService {}
class MockCoordinator extends Mock implements ActiveScopeCoordinator {}
class MockAccountSessionAdapter extends Mock implements AccountReadingSessionAdapter {}
class MockGuestSessionAdapter extends Mock implements GuestReadingSessionAdapter {}

void main() {
  group('Task 2: ScopedReadingSessionDispatcher & Scope-Coherence Guard', () {
    late MockAuthService mockAuth;
    late MockCoordinator mockCoordinator;
    late MockAccountSessionAdapter mockAccountAdapter;
    late MockGuestSessionAdapter mockGuestAdapter;
    late ScopedReadingSessionDispatcher dispatcher;

    setUp(() {
      mockAuth = MockAuthService();
      mockCoordinator = MockCoordinator();
      mockAccountAdapter = MockAccountSessionAdapter();
      mockGuestAdapter = MockGuestSessionAdapter();

      dispatcher = ScopedReadingSessionDispatcher(
        authService: mockAuth,
        coordinator: mockCoordinator,
        accountAdapter: mockAccountAdapter,
        guestAdapter: mockGuestAdapter,
      );
    });

    test('1. Coherent Account: dispatches progress to AccountReadingSessionAdapter only', () async {
      when(() => mockAuth.state).thenReturn(
        const AuthState(
          status: AuthStatus.authenticated,
          user: User(id: 'usr-456', email: 'acc@test.com', username: 'acc456', role: 'READER'),
        ),
      );
      when(() => mockCoordinator.state).thenReturn(ActiveScopeState.account);
      when(() => mockCoordinator.activeScope).thenReturn('account:usr-456');

      when(() => mockAccountAdapter.recordProgress(
            storyId: any(named: 'storyId'),
            chapterId: any(named: 'chapterId'),
            chapterVersionId: any(named: 'chapterVersionId'),
            readingMode: any(named: 'readingMode'),
            flutterPageIndex: any(named: 'flutterPageIndex'),
            progressPercentage: any(named: 'progressPercentage'),
            scrollPosition: any(named: 'scrollPosition'),
            anchorBlockId: any(named: 'anchorBlockId'),
            textOffset: any(named: 'textOffset'),
            storyTitle: any(named: 'storyTitle'),
            storySlug: any(named: 'storySlug'),
            storyCoverUrl: any(named: 'storyCoverUrl'),
            chapterNumber: any(named: 'chapterNumber'),
            chapterTitle: any(named: 'chapterTitle'),
          )).thenReturn(null);

      dispatcher.recordProgress(
        storyId: 's-acc-1',
        chapterId: 'c1',
        flutterPageIndex: 1,
        progressPercentage: 25.0,
        scrollPosition: 100.0,
      );

      verify(() => mockAccountAdapter.recordProgress(
            storyId: 's-acc-1',
            chapterId: 'c1',
            chapterVersionId: null,
            readingMode: 'WEBTOON',
            flutterPageIndex: 1,
            progressPercentage: 25.0,
            scrollPosition: 100.0,
            anchorBlockId: null,
            textOffset: null,
            storyTitle: null,
            storySlug: null,
            storyCoverUrl: null,
            chapterNumber: null,
            chapterTitle: null,
          )).called(1);
      verifyZeroInteractions(mockGuestAdapter); // Invariant: Zero guest touch
    });

    test('2. Coherent Guest: dispatches progress to GuestReadingSessionAdapter only', () async {
      when(() => mockAuth.state).thenReturn(AuthState.unauthenticated());
      when(() => mockCoordinator.state).thenReturn(ActiveScopeState.guest);
      when(() => mockCoordinator.activeScope).thenReturn('guest:gst-reader-999');

      when(() => mockGuestAdapter.recordProgress(
            storyId: any(named: 'storyId'),
            chapterId: any(named: 'chapterId'),
            chapterVersionId: any(named: 'chapterVersionId'),
            readingMode: any(named: 'readingMode'),
            flutterPageIndex: any(named: 'flutterPageIndex'),
            progressPercentage: any(named: 'progressPercentage'),
            scrollPosition: any(named: 'scrollPosition'),
            anchorBlockId: any(named: 'anchorBlockId'),
            textOffset: any(named: 'textOffset'),
            storyTitle: any(named: 'storyTitle'),
            storySlug: any(named: 'storySlug'),
            storyCoverUrl: any(named: 'storyCoverUrl'),
            chapterNumber: any(named: 'chapterNumber'),
            chapterTitle: any(named: 'chapterTitle'),
          )).thenReturn(null);

      dispatcher.recordProgress(
        storyId: 's-guest-1',
        chapterId: 'c2',
        flutterPageIndex: 3,
        progressPercentage: 60.0,
        scrollPosition: 300.0,
        storyTitle: 'Guest Story',
      );

      verify(() => mockGuestAdapter.recordProgress(
            storyId: 's-guest-1',
            chapterId: 'c2',
            chapterVersionId: null,
            readingMode: 'WEBTOON',
            flutterPageIndex: 3,
            progressPercentage: 60.0,
            scrollPosition: 300.0,
            anchorBlockId: null,
            textOffset: null,
            storyTitle: 'Guest Story',
            storySlug: null,
            storyCoverUrl: null,
            chapterNumber: null,
            chapterTitle: null,
          )).called(1);
      verifyZeroInteractions(mockAccountAdapter); // Invariant: Zero account touch
    });

    test('3. Scope mismatch / transitioning: Fail-Closed on recordProgress', () async {
      // Ví dụ: AuthService đã unauthenticated nhưng coordinator vẫn còn account:usr-456
      when(() => mockAuth.state).thenReturn(AuthState.unauthenticated());
      when(() => mockCoordinator.state).thenReturn(ActiveScopeState.account);
      when(() => mockCoordinator.activeScope).thenReturn('account:usr-456');

      expect(
        () => dispatcher.recordProgress(
          storyId: 's-leak',
          chapterId: 'c3',
          flutterPageIndex: 0,
          progressPercentage: 10.0,
          scrollPosition: 0.0,
        ),
        throwsA(isA<ScopeCoherenceException>()),
      );

      verifyZeroInteractions(mockAccountAdapter);
      verifyZeroInteractions(mockGuestAdapter);
    });

    test('4. Bootstrapping / null scope: Fail-Closed on recordProgress', () async {
      when(() => mockAuth.state).thenReturn(AuthState.initial());
      when(() => mockCoordinator.state).thenReturn(ActiveScopeState.bootstrapping);
      when(() => mockCoordinator.activeScope).thenReturn(null);

      expect(
        () => dispatcher.recordProgress(
          storyId: 's-boot',
          chapterId: 'c4',
          flutterPageIndex: 0,
          progressPercentage: 0.0,
          scrollPosition: 0.0,
        ),
        throwsA(isA<ScopeCoherenceException>()),
      );

      verifyZeroInteractions(mockAccountAdapter);
      verifyZeroInteractions(mockGuestAdapter);
    });

    test('5. Race Guard: AuthStatus.authenticating + stale activeScope=guest:G => recordProgress fail-closed', () async {
      when(() => mockAuth.state).thenReturn(
        const AuthState(status: AuthStatus.authenticating),
      );
      when(() => mockCoordinator.state).thenReturn(ActiveScopeState.guest);
      when(() => mockCoordinator.activeScope).thenReturn('guest:gst-stale-333');

      expect(
        () => dispatcher.recordProgress(
          storyId: 's-race-1',
          chapterId: 'c-race-1',
          flutterPageIndex: 1,
          progressPercentage: 10.0,
          scrollPosition: 0.0,
        ),
        throwsA(isA<ScopeCoherenceException>()),
      );

      verifyZeroInteractions(mockAccountAdapter);
      verifyZeroInteractions(mockGuestAdapter);
    });

    test('6. Race Guard: AuthStatus.unauthenticated + coordinator.state=transitioning + stale activeScope=guest:G => recordProgress fail-closed', () async {
      when(() => mockAuth.state).thenReturn(AuthState.unauthenticated());
      when(() => mockCoordinator.state).thenReturn(ActiveScopeState.transitioning);
      when(() => mockCoordinator.activeScope).thenReturn('guest:gst-stale-444');

      expect(
        () => dispatcher.recordProgress(
          storyId: 's-race-2',
          chapterId: 'c-race-2',
          flutterPageIndex: 2,
          progressPercentage: 20.0,
          scrollPosition: 0.0,
        ),
        throwsA(isA<ScopeCoherenceException>()),
      );

      verifyZeroInteractions(mockAccountAdapter);
      verifyZeroInteractions(mockGuestAdapter);
    });
  });
}
