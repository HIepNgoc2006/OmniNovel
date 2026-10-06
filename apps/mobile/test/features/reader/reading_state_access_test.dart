import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/reader/models/reading_progress_models.dart';
import 'package:omninovel_mobile/features/reader/models/story_reading_state.dart';
import 'package:omninovel_mobile/features/reader/presentation/reading_progress_coordinator.dart';
import 'package:omninovel_mobile/features/reader/repositories/account_reading_state_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_progress_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/guest_reading_state_adapter.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_progress_repository.dart';
import 'package:omninovel_mobile/features/reader/repositories/reading_state_access.dart';
import 'package:omninovel_mobile/features/reader/repositories/scoped_reading_state_dispatcher.dart';

class MockReadingProgressRepository extends Mock
    implements ReadingProgressRepository {}

class MockGuestReadingProgressRepository extends Mock
    implements GuestReadingProgressRepository {}

class MockReadingStateAccess extends Mock implements ReadingStateAccess {}

class FakeAuthService extends ChangeNotifier implements AuthService {
  AuthState _state = const AuthState(status: AuthStatus.unauthenticated);

  @override
  AuthState get state => _state;

  void updateState(AuthState newState) {
    _state = newState;
    notifyListeners();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class FakeCoordinator extends ChangeNotifier
    implements ActiveScopeCoordinator {
  String? _scope;
  ActiveScopeState _state = ActiveScopeState.bootstrapping;

  @override
  ActiveScopeState get state => _state;

  @override
  String? get activeScope => _scope;

  void updateScope(String? newScope, {ActiveScopeState? state}) {
    _scope = newScope;
    if (state != null) {
      _state = state;
    } else if (newScope == null) {
      _state = ActiveScopeState.bootstrapping;
    } else if (newScope.startsWith('account:')) {
      _state = ActiveScopeState.account;
    } else if (newScope.startsWith('guest:')) {
      _state = ActiveScopeState.guest;
    }
    notifyListeners();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ReadingStateAccess: Adapters & Scoped Dispatcher', () {
    late MockReadingProgressRepository mockAccountRepo;
    late MockGuestReadingProgressRepository mockGuestRepo;
    late FakeAuthService authService;
    late FakeCoordinator coordinator;

    setUp(() {
      mockAccountRepo = MockReadingProgressRepository();
      mockGuestRepo = MockGuestReadingProgressRepository();
      authService = FakeAuthService();
      coordinator = FakeCoordinator();
    });

    group('AccountReadingStateAdapter', () {
      test('fetches server progress + checkpoint, hydrates epoch, resolves pointer',
          () async {
        final adapter =
            AccountReadingStateAdapter(repository: mockAccountRepo);

        when(() => mockAccountRepo.getProgress('story-1')).thenAnswer(
          (_) async => const ReadingProgressResponse(
            storyId: 'story-1',
            chapterId: 'chap-10',
            pageIndex: 5,
            progressPercentage: 45.0,
            scrollPosition: 120.0,
            readChapterIds: ['chap-1', 'chap-2'],
            writeEpoch: 42,
          ),
        );
        when(() => mockAccountRepo.getLocalCheckpoint('story-1')).thenAnswer(
          (_) async => null,
        );
        when(() => mockAccountRepo.setServerEpoch('story-1', 42))
            .thenReturn(null);

        final state = await adapter.getStoryReadingState('story-1');

        verify(() => mockAccountRepo.getProgress('story-1')).called(1);
        verify(() => mockAccountRepo.getLocalCheckpoint('story-1')).called(1);
        verify(() => mockAccountRepo.setServerEpoch('story-1', 42)).called(1);

        expect(state.resume, isNotNull);
        expect(state.resume!.chapterId, 'chap-10');
        expect(state.resume!.flutterPageIndex, 4);
        expect(state.resume!.serverPageIndex, 5);
        expect(state.resume!.progressPercentage, 45.0);
        expect(state.resume!.scrollPosition, 120.0);
        expect(state.resume!.isFromLocal, isFalse);
        expect(state.readChapterIds, {'chap-1', 'chap-2'});
      });

      test('gracefully handles network failure in getProgress and falls back to local checkpoint',
          () async {
        final adapter =
            AccountReadingStateAdapter(repository: mockAccountRepo);

        when(() => mockAccountRepo.getProgress('story-1'))
            .thenThrow(Exception('Network offline'));
        when(() => mockAccountRepo.getLocalCheckpoint('story-1')).thenAnswer(
          (_) async => LocalReadingCheckpoint(
            storyId: 'story-1',
            chapterId: 'chap-local',
            pageIndex: 3,
            progressPercentage: 30.0,
            scrollPosition: 80.0,
            updatedAt: DateTime.now(),
          ),
        );

        final state = await adapter.getStoryReadingState('story-1');

        expect(state.resume, isNotNull);
        expect(state.resume!.chapterId, 'chap-local');
        expect(state.resume!.flutterPageIndex, 2);
        expect(state.resume!.isFromLocal, isTrue);
        expect(state.readChapterIds, isEmpty);
        verifyNever(() => mockAccountRepo.setServerEpoch(any(), any()));
      });
    });

    group('GuestReadingStateAdapter', () {
      test('fetches progress and read chapters purely from SQLite, zero epoch, zero HTTP',
          () async {
        final adapter =
            GuestReadingStateAdapter(guestRepository: mockGuestRepo);

        when(() => mockGuestRepo.getProgress('story-gst-1')).thenAnswer(
          (_) async => LocalReadingProgress(
            ownerScope: 'guest:gst-1',
            storyId: 'story-gst-1',
            chapterId: 'chap-gst-7',
            pageIndex: 4,
            progressPercentage: 55.0,
            scrollPosition: 200.0,
            anchorBlockId: 'block-9',
            updatedAt: DateTime.now(),
            deviceTimestamp: DateTime.now(),
          ),
        );
        when(() => mockGuestRepo.getReadChapterIds('story-gst-1')).thenAnswer(
          (_) async => ['chap-gst-1', 'chap-gst-2', 'chap-gst-3'],
        );

        final state = await adapter.getStoryReadingState('story-gst-1');

        verify(() => mockGuestRepo.getProgress('story-gst-1')).called(1);
        verify(() => mockGuestRepo.getReadChapterIds('story-gst-1')).called(1);

        expect(state.resume, isNotNull);
        expect(state.resume!.chapterId, 'chap-gst-7');
        expect(state.resume!.flutterPageIndex, 3);
        expect(state.resume!.serverPageIndex, 4);
        expect(state.resume!.progressPercentage, 55.0);
        expect(state.resume!.scrollPosition, 200.0);
        expect(state.resume!.anchorBlockId, 'block-9');
        expect(state.resume!.isFromLocal, isTrue);
        expect(state.readChapterIds, {'chap-gst-1', 'chap-gst-2', 'chap-gst-3'});
      });

      test('returns null resume when guest has no previous progress for story',
          () async {
        final adapter =
            GuestReadingStateAdapter(guestRepository: mockGuestRepo);

        when(() => mockGuestRepo.getProgress('story-new')).thenAnswer(
          (_) async => null,
        );
        when(() => mockGuestRepo.getReadChapterIds('story-new')).thenAnswer(
          (_) async => [],
        );

        final state = await adapter.getStoryReadingState('story-new');

        expect(state.resume, isNull);
        expect(state.readChapterIds, isEmpty);
      });
    });

    group('ScopedReadingStateDispatcher', () {
      late MockReadingStateAccess mockAccountAdapter;
      late MockReadingStateAccess mockGuestAdapter;
      late ScopedReadingStateDispatcher dispatcher;

      setUp(() {
        mockAccountAdapter = MockReadingStateAccess();
        mockGuestAdapter = MockReadingStateAccess();
        dispatcher = ScopedReadingStateDispatcher(
          authService: authService,
          coordinator: coordinator,
          accountAdapter: mockAccountAdapter,
          guestAdapter: mockGuestAdapter,
        );
      });

      test('routes to account adapter when 4-tuple coherence guard matches authenticated account',
          () async {
        authService.updateState(const AuthState(
          status: AuthStatus.authenticated,
          user: User(id: 'usr-42', email: 'u42@test.com', username: 'u42', role: 'READER'),
        ));
        coordinator.updateScope('account:usr-42', state: ActiveScopeState.account);

        when(() => mockAccountAdapter.getStoryReadingState('story-1')).thenAnswer(
          (_) async => const StoryReadingState(
            resume: ResumePointer(
              chapterId: 'c-acc',
              flutterPageIndex: 0,
              serverPageIndex: 1,
              progressPercentage: 10,
              scrollPosition: 0,
              isFromLocal: false,
            ),
            readChapterIds: {'c-acc'},
          ),
        );

        final result = await dispatcher.getStoryReadingState('story-1');

        verify(() => mockAccountAdapter.getStoryReadingState('story-1')).called(1);
        verifyZeroInteractions(mockGuestAdapter);
        expect(result.resume?.chapterId, 'c-acc');
      });

      test('routes to guest adapter when 4-tuple coherence guard matches unauthenticated guest',
          () async {
        authService.updateState(AuthState.unauthenticated());
        coordinator.updateScope('guest:gst-valid', state: ActiveScopeState.guest);

        when(() => mockGuestAdapter.getStoryReadingState('story-1')).thenAnswer(
          (_) async => const StoryReadingState(
            resume: ResumePointer(
              chapterId: 'c-gst',
              flutterPageIndex: 2,
              serverPageIndex: 3,
              progressPercentage: 50,
              scrollPosition: 100,
              isFromLocal: true,
            ),
            readChapterIds: {'c-gst'},
          ),
        );

        final result = await dispatcher.getStoryReadingState('story-1');

        verify(() => mockGuestAdapter.getStoryReadingState('story-1')).called(1);
        verifyZeroInteractions(mockAccountAdapter);
        expect(result.resume?.chapterId, 'c-gst');
      });

      test('fails closed with neutral empty state during bootstrapping / transitioning / mismatch',
          () async {
        // Case: Transitioning
        authService.updateState(AuthState.unauthenticated());
        coordinator.updateScope('guest:gst-old', state: ActiveScopeState.transitioning);

        final result1 = await dispatcher.getStoryReadingState('story-1');
        expect(result1.resume, isNull);
        expect(result1.readChapterIds, isEmpty);

        // Case: Mismatch (auth authenticated but coordinator guest)
        authService.updateState(const AuthState(
          status: AuthStatus.authenticated,
          user: User(id: 'usr-1', email: 'u@test.com', username: 'u', role: 'READER'),
        ));
        coordinator.updateScope('guest:gst-stale', state: ActiveScopeState.guest);

        final result2 = await dispatcher.getStoryReadingState('story-1');
        expect(result2.resume, isNull);
        expect(result2.readChapterIds, isEmpty);

        verifyZeroInteractions(mockAccountAdapter);
        verifyZeroInteractions(mockGuestAdapter);
      });
    });
  });
}
