import 'dart:convert';
import 'dart:io';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/claim/guest_claim_coordinator.dart';
import 'package:omninovel_mobile/core/claim/models/guest_claim_models.dart';
import 'package:omninovel_mobile/core/claim/scope_coordinator_claim_bridge.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/storage/local_library_dao.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class MockApiClient extends Mock implements ApiClient {}

class FakeScopeCoordinatorClaimBridge implements ScopeCoordinatorClaimBridge {
  int _generation = 1;
  final List<Map<String, dynamic>> resolveCalls = [];
  final List<String> pendingUnavailableCalls = [];

  @override
  int get transitionGeneration => _generation;

  void bumpGeneration() {
    _generation++;
  }

  @override
  Future<void> resolveToAccount(String userId, {required int expectedGeneration}) async {
    if (expectedGeneration != _generation) {
      throw StateError(
        'Stale resolve: expectedGeneration=$expectedGeneration does not match current=$_generation',
      );
    }
    resolveCalls.add({'userId': userId, 'expectedGeneration': expectedGeneration});
  }

  @override
  void markPendingUnavailable(String message) {
    pendingUnavailableCalls.add(message);
  }
}

class FakeAuthService extends Fake implements AuthService {
  AuthState _state;
  FakeAuthService(this._state);

  @override
  AuthState get state => _state;

  void updateUser(User? user) {
    if (user != null) {
      _state = AuthState.authenticated(user: user, accessToken: 'dummy-token');
    } else {
      _state = AuthState.unauthenticated();
    }
  }
}

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  late Directory tempDir;
  late String dbPath;
  late OfflineDatabase offlineDb;
  late LocalLibraryDao dao;
  late MockApiClient mockApiClient;
  late FakeScopeCoordinatorClaimBridge fakeBridge;
  late FakeAuthService fakeAuthService;
  late GuestProfileIdentityProvider guestProvider;
  late SharedPreferences prefs;

  const testUserId = 'user-uuid-1111';
  const testGuestProfileId = 'guest-profile-2222';
  const testClaimId = 'claim-uuid-3333';
  const testFingerprint = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  final standardPreviewJson = {
    'claimId': testClaimId,
    'status': 'PREPARED',
    'stateFingerprint': testFingerprint,
    'expiresAt': '2026-10-15T12:00:00.000Z',
    'bookmarksToImport': 1,
    'historyToImport': 1,
    'progressToImport': 1,
    'conflictsCount': 0,
    'readStatesIgnoredAntiResurrectionCount': 0,
    'conflicts': <Map<String, dynamic>>[],
  };

  final standardCommitJson = {
    'claimId': testClaimId,
    'status': 'COMMITTED',
    'committedAt': '2026-10-14T12:00:00.000Z',
    'summary': {
      'bookmarksImported': 1,
      'historyMerged': 1,
      'progressUpdated': 1,
      'conflictsResolved': 0,
    },
    'finalization': {
      'tombstonedStoryIds': <String>[],
      'finalizedProgress': [
        {
          'storyId': 'story-claim-1',
          'chapterId': 'chap-1',
          'chapterVersionId': 'ver-1',
          'readingMode': 'PAGED',
          'pageIndex': 5,
          'scrollPosition': 0.0,
          'progressPercentage': 50.0,
          'anchorBlockId': null,
          'textOffset': null,
          'updatedAt': '2026-10-14T12:00:00.000Z',
          'deviceTimestamp': 1700000000000,
        }
      ],
      'finalizedChapterReadStates': [
        {
          'storyId': 'story-claim-1',
          'chapterId': 'chap-1',
          'chapterVersionId': 'ver-1',
          'progressPercentage': 50.0,
          'completedAt': null,
          'lastReadAt': '2026-10-14T12:00:00.000Z',
        }
      ],
    },
  };

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('guest_claim_coord_test_');
    dbPath = p.join(tempDir.path, 'guest_claim_coord.db');
    offlineDb = OfflineDatabase();
    await offlineDb.initialize(
      customPath: dbPath,
      databaseFactory: databaseFactoryFfi,
    );
    dao = LocalLibraryDao(offlineDatabase: offlineDb);

    SharedPreferences.setMockInitialValues({
      GuestProfileIdentityProvider.keyGuestProfileId: testGuestProfileId,
    });
    prefs = await SharedPreferences.getInstance();
    guestProvider = GuestProfileIdentityProvider(prefs: prefs);

    mockApiClient = MockApiClient();
    fakeBridge = FakeScopeCoordinatorClaimBridge();
    fakeAuthService = FakeAuthService(
      AuthState.authenticated(
        user: const User(
          id: testUserId,
          username: 'testuser',
          email: 'test@example.com',
          role: 'READER',
        ),
        accessToken: 'dummy-token',
      ),
    );
  });

  tearDown(() async {
    try {
      if (offlineDb.isInitialized) {
        await offlineDb.database.close();
      }
      await databaseFactoryFfi.deleteDatabase(dbPath);
    } catch (_) {}
    try {
      if (await tempDir.exists()) {
        await tempDir.delete(recursive: true);
      }
    } catch (_) {}
  });

  GuestClaimCoordinator createCoordinator() {
    return GuestClaimCoordinator(
      dao: dao,
      scopeBridge: fakeBridge,
      guestProvider: guestProvider,
      apiClient: mockApiClient,
      offlineDb: offlineDb,
      authService: fakeAuthService,
      prefs: prefs,
    );
  }

  group('Task 3: GuestClaimCoordinator Engine & Durable Crash Recovery (TDD RED)', () {
    test('1. checkAndPrepareClaim: When guest has NO data -> immediately calls resolveToAccount without opening modal', () async {
      final coordinator = createCoordinator();

      // Guest partition is empty
      expect(await dao.hasGuestData('guest:$testGuestProfileId'), isFalse);

      await coordinator.checkAndPrepareClaim(testUserId);

      // Verify no modal opened and resolved directly to account
      expect(coordinator.isOpen, isFalse);
      expect(fakeBridge.resolveCalls.length, equals(1));
      expect(fakeBridge.resolveCalls.first['userId'], equals(testUserId));
      expect(fakeBridge.resolveCalls.first['expectedGeneration'], equals(1));
      verifyZeroInteractions(mockApiClient);
    });

    test('2. checkAndPrepareClaim: When guest has data -> calls /prepare and records journal BEFORE opening modal', () async {
      // Seed guest bookmark and history
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: DateTime.now().toUtc(),
      ));
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        chapterId: 'chap-1',
        storyTitle: 'Claim Story 1',
        chapterNumber: '1',
        progressPercentage: 50.0,
        lastReadAt: DateTime.now().toUtc(),
      ));

      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimPrepare,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.guestClaimPrepare),
            statusCode: 200,
            data: standardPreviewJson,
          ));

      final coordinator = createCoordinator();

      await coordinator.checkAndPrepareClaim(testUserId);

      // Verify modal is open and previewData loaded
      expect(coordinator.isOpen, isTrue);
      expect(coordinator.currentClaimId, equals(testClaimId));
      expect(coordinator.currentUserId, equals(testUserId));
      expect(coordinator.previewData, isNotNull);
      expect(coordinator.previewData!.claimId, equals(testClaimId));

      // Invariant: Journal record must be written to SQLite with phase 'prepared'
      final journalRows = await offlineDb.database.query(
        'guest_claim_recovery_journal',
        where: 'claim_id = ?',
        whereArgs: [testClaimId],
      );
      expect(journalRows.length, equals(1));
      expect(journalRows.first['phase'], equals('prepared'));
      expect(journalRows.first['user_id'], equals(testUserId));
      expect(journalRows.first['guest_profile_id'], equals(testGuestProfileId));
      expect(journalRows.first['expected_state_fingerprint'], equals(testFingerprint));
    });

    test('3. checkAndPrepareClaim: Fail-closed on prepare API or DB error -> marks pending unavailable, retains transitioning', () async {
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: DateTime.now().toUtc(),
      ));

      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimPrepare,
            data: any<dynamic>(named: 'data'),
          )).thenThrow(DioException(
        requestOptions: RequestOptions(path: ApiEndpoints.guestClaimPrepare),
        error: 'Network connection timeout',
      ));

      final coordinator = createCoordinator();

      await coordinator.checkAndPrepareClaim(testUserId);

      expect(coordinator.isOpen, isFalse);
      expect(coordinator.error, isNotNull);
      expect(fakeBridge.resolveCalls, isEmpty);
      expect(fakeBridge.pendingUnavailableCalls.length, equals(1));
    });

    test('4. Concurrency Guard (Triple-Check): Discards stale prepare response if generation changed or user logged out', () async {
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: DateTime.now().toUtc(),
      ));

      // Simulate delay in network response during which generation bumps (user logout/login)
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimPrepare,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async {
        fakeBridge.bumpGeneration(); // Transition generation bumped!
        return Response(
          requestOptions: RequestOptions(path: ApiEndpoints.guestClaimPrepare),
          statusCode: 200,
          data: standardPreviewJson,
        );
      });

      final coordinator = createCoordinator();

      await coordinator.checkAndPrepareClaim(testUserId);

      // Invariant: Stale prepare callback must be completely discarded
      expect(coordinator.isOpen, isFalse);
      expect(fakeBridge.resolveCalls, isEmpty);

      // Journal must NOT be written for stale session
      final journalRows = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(journalRows, isEmpty);
    });

    test('5. confirmClaim: Writes journal phase committing BEFORE network call, executes rebindScope on 200 COMMITTED, and resolves to account', () async {
      // Seed guest data
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: DateTime.now().toUtc(),
      ));
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        chapterId: 'chap-1',
        storyTitle: 'Claim Story 1',
        chapterNumber: '1',
        progressPercentage: 50.0,
        lastReadAt: DateTime.now().toUtc(),
      ));

      // Seed journal in prepared phase
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      bool verifiedCommittingBeforeHttp = false;
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimCommit(testClaimId),
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async {
        // Verify in SQLite that phase was set to 'committing' BEFORE HTTP request was dispatched
        final rows = await offlineDb.database.query(
          'guest_claim_recovery_journal',
          where: 'claim_id = ?',
          whereArgs: [testClaimId],
        );
        if (rows.isNotEmpty && rows.first['phase'] == 'committing') {
          verifiedCommittingBeforeHttp = true;
        }
        return Response(
          requestOptions: RequestOptions(path: ApiEndpoints.guestClaimCommit(testClaimId)),
          statusCode: 200,
          data: standardCommitJson,
        );
      });

      final coordinator = createCoordinator();
      // Setup active claim state
      coordinator.currentClaimId = testClaimId;
      coordinator.currentUserId = testUserId;
      coordinator.isOpen = true;
      coordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);

      await coordinator.confirmClaim(testUserId, {});

      expect(verifiedCommittingBeforeHttp, isTrue);
      expect(coordinator.isOpen, isFalse);
      expect(coordinator.isCommitting, isFalse);

      // Verify rebindScope executed: targetScope has bookmark and history, guest is purged
      final targetBm = await dao.getBookmark(ownerScope: 'account:$testUserId', storyId: 'story-claim-1');
      expect(targetBm, isNotNull);
      expect(await dao.hasGuestData('guest:$testGuestProfileId'), isFalse);

      // Journal record removed
      final remainingJournal = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(remainingJournal, isEmpty);

      // Scope resolved to account
      expect(fakeBridge.resolveCalls.length, equals(1));
      expect(fakeBridge.resolveCalls.first['userId'], equals(testUserId));
    });

    test('6. confirmClaim: 409 Conflict triggers auto re-prepare, replaces journal, and updates preview data', () async {
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      // Commit returns 409 Conflict
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimCommit(testClaimId),
            data: any<dynamic>(named: 'data'),
          )).thenThrow(DioException(
        requestOptions: RequestOptions(path: ApiEndpoints.guestClaimCommit(testClaimId)),
        response: Response(
          requestOptions: RequestOptions(path: ApiEndpoints.guestClaimCommit(testClaimId)),
          statusCode: 409,
          data: {'message': 'State fingerprint conflict'},
        ),
      ));

      final newPreviewJson = Map<String, dynamic>.from(standardPreviewJson);
      newPreviewJson['claimId'] = 'new-claim-uuid-4444';
      newPreviewJson['stateFingerprint'] = 'b' * 64;

      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimPrepare,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.guestClaimPrepare),
            statusCode: 200,
            data: newPreviewJson,
          ));

      final coordinator = createCoordinator();
      coordinator.currentClaimId = testClaimId;
      coordinator.currentUserId = testUserId;
      coordinator.isOpen = true;
      coordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);

      await coordinator.confirmClaim(testUserId, {});

      // Verify re-prepared with new claimId
      expect(coordinator.isOpen, isTrue);
      expect(coordinator.currentClaimId, equals('new-claim-uuid-4444'));
      expect(coordinator.previewData!.stateFingerprint, equals('b' * 64));
      expect(fakeBridge.resolveCalls, isEmpty);
    });

    test('7. skipClaim: In prepared phase -> records quarantine marker, removes journal, preserves guest SQLite data 100%, resolves account', () async {
      // Seed guest bookmark
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-skip-preserve',
        title: 'Skip Preserve Story',
        createdAt: DateTime.now().toUtc(),
      ));

      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      final coordinator = createCoordinator();
      coordinator.currentClaimId = testClaimId;
      coordinator.currentUserId = testUserId;
      coordinator.isOpen = true;

      await coordinator.skipClaim(testUserId);

      // Verify modal closed
      expect(coordinator.isOpen, isFalse);

      // Verify quarantine marker was stored
      final quarantined = prefs.getStringList(GuestProfileIdentityProvider.keyQuarantinedProfiles) ?? [];
      expect(quarantined, contains(testGuestProfileId));

      // Verify journal record deleted
      final remainingJournal = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(remainingJournal, isEmpty);

      // Verify guest data is 100% PRESERVED
      expect(await dao.hasGuestData('guest:$testGuestProfileId'), isTrue);
      expect(await dao.isBookmarked(ownerScope: 'guest:$testGuestProfileId', storyId: 'story-skip-preserve'), isTrue);

      // Verify resolved to account
      expect(fakeBridge.resolveCalls.length, equals(1));
    });

    test('8. skipClaim: In committing or committedServer phase -> throws StateError to prevent data loss', () async {
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'committing',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      final coordinator = createCoordinator();
      coordinator.currentClaimId = testClaimId;
      coordinator.currentUserId = testUserId;
      coordinator.isOpen = true;

      await expectLater(
        coordinator.skipClaim(testUserId),
        throwsA(isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('Cannot skip claim once commit has started'),
        )),
      );
    });

    test('9. Crash Recovery Matrix: Ignores journal record belonging to a different user', () async {
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': 'other-user-claim',
        'user_id': 'different-user-9999',
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'committedServer',
        'preview_data': null,
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      final coordinator = createCoordinator();

      await coordinator.checkCrashRecovery(testUserId);

      // Invariant: Different user claim is untouched
      expect(coordinator.isOpen, isFalse);
      expect(fakeBridge.resolveCalls, isEmpty);
      final rows = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(rows.length, equals(1));
      expect(rows.first['user_id'], equals('different-user-9999'));
    });

    test('10. Crash Recovery Matrix: Recovers committedServer phase -> executes rebindScope, deletes journal, and resolves account', () async {
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: DateTime.now().toUtc(),
      ));
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        chapterId: 'chap-1',
        storyTitle: 'Claim Story 1',
        chapterNumber: '1',
        progressPercentage: 50.0,
        lastReadAt: DateTime.now().toUtc(),
      ));

      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'committedServer',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      // GET /status returns COMMITTED with finalization snapshot
      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.guestClaimStatus(testClaimId),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.guestClaimStatus(testClaimId)),
            statusCode: 200,
            data: {
              'claimId': testClaimId,
              'status': 'COMMITTED',
              'expiresAt': '2026-10-15T12:00:00.000Z',
              'committedAt': '2026-10-14T12:00:00.000Z',
              'previewData': standardPreviewJson,
              'resultSummary': {
                'bookmarksImported': 1,
                'historyMerged': 1,
                'progressUpdated': 1,
                'conflictsResolved': 0,
              },
              'finalization': standardCommitJson['finalization'],
            },
          ));

      final coordinator = createCoordinator();

      await coordinator.checkCrashRecovery(testUserId);

      // Verify recovery applied rebindScope and cleaned up journal
      expect(coordinator.isOpen, isFalse);
      final remainingJournal = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(remainingJournal, isEmpty);

      // Guest partition purged, target populated
      expect(await dao.hasGuestData('guest:$testGuestProfileId'), isFalse);
      expect(await dao.getBookmark(ownerScope: 'account:$testUserId', storyId: 'story-claim-1'), isNotNull);

      // Account resolved
      expect(fakeBridge.resolveCalls.length, equals(1));
      expect(fakeBridge.resolveCalls.first['userId'], equals(testUserId));
    });

    test('11. Crash Recovery Matrix: Recovers prepared phase -> restores preview data from journal, opens bottom sheet modal', () async {
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      final coordinator = createCoordinator();

      await coordinator.checkCrashRecovery(testUserId);

      // Verify modal re-opened with restored preview data
      expect(coordinator.isOpen, isTrue);
      expect(coordinator.currentClaimId, equals(testClaimId));
      expect(coordinator.previewData, isNotNull);
      expect(coordinator.previewData!.claimId, equals(testClaimId));
      expect(fakeBridge.resolveCalls, isEmpty);
    });

    test('12. Crash Recovery Matrix: Network failure during recovery -> marks pending unavailable, retains transitioning', () async {
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'committing',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.guestClaimStatus(testClaimId),
          )).thenThrow(DioException(
        requestOptions: RequestOptions(path: ApiEndpoints.guestClaimStatus(testClaimId)),
        error: 'Network offline during crash recovery',
      ));

      final coordinator = createCoordinator();

      await coordinator.checkCrashRecovery(testUserId);

      // Retains transitioning fail-closed
      expect(fakeBridge.resolveCalls, isEmpty);
      expect(fakeBridge.pendingUnavailableCalls.length, equals(1));
    });

    test('13. HTTP commit timeout, server actually COMMITTED -> GET /status recovers, rebinds, and resolves without blind retry', () async {
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: DateTime.now().toUtc(),
      ));
      await dao.saveHistory(LocalReadingHistory(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        chapterId: 'chap-1',
        storyTitle: 'Claim Story 1',
        chapterNumber: '1',
        progressPercentage: 50.0,
        lastReadAt: DateTime.now().toUtc(),
      ));

      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      // POST /commit throws Timeout exception
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimCommit(testClaimId),
            data: any<dynamic>(named: 'data'),
          )).thenThrow(DioException(
        requestOptions: RequestOptions(path: ApiEndpoints.guestClaimCommit(testClaimId)),
        type: DioExceptionType.connectionTimeout,
        error: 'Connection timeout during commit',
      ));

      // But subsequent GET /status discovers server actually COMMITTED!
      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.guestClaimStatus(testClaimId),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.guestClaimStatus(testClaimId)),
            statusCode: 200,
            data: {
              'claimId': testClaimId,
              'status': 'COMMITTED',
              'expiresAt': '2026-10-15T12:00:00.000Z',
              'committedAt': '2026-10-14T12:00:00.000Z',
              'previewData': standardPreviewJson,
              'resultSummary': standardCommitJson['summary'],
              'finalization': standardCommitJson['finalization'],
            },
          ));

      final coordinator = createCoordinator();
      coordinator.currentClaimId = testClaimId;
      coordinator.currentUserId = testUserId;
      coordinator.isOpen = true;
      coordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);

      await coordinator.confirmClaim(testUserId, {});

      // Invariant: Resolved via status check recovery without blind retry
      expect(coordinator.isOpen, isFalse);
      expect(fakeBridge.resolveCalls.length, equals(1));
      expect(fakeBridge.resolveCalls.first['userId'], equals(testUserId));

      // Guest partition purged and journal deleted
      expect(await dao.hasGuestData('guest:$testGuestProfileId'), isFalse);
      expect(await offlineDb.database.query('guest_claim_recovery_journal'), isEmpty);
    });

    test('14. HTTP commit timeout, status unavailable -> keeps phase committing, skipClaim is strictly blocked', () async {
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimCommit(testClaimId),
            data: any<dynamic>(named: 'data'),
          )).thenThrow(DioException(
        requestOptions: RequestOptions(path: ApiEndpoints.guestClaimCommit(testClaimId)),
        type: DioExceptionType.connectionTimeout,
        error: 'Connection timeout during commit',
      ));

      when(() => mockApiClient.get<Map<String, dynamic>>(
            ApiEndpoints.guestClaimStatus(testClaimId),
          )).thenThrow(DioException(
        requestOptions: RequestOptions(path: ApiEndpoints.guestClaimStatus(testClaimId)),
        error: 'Network unreachable',
      ));

      final coordinator = createCoordinator();
      coordinator.currentClaimId = testClaimId;
      coordinator.currentUserId = testUserId;
      coordinator.isOpen = true;
      coordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);

      await coordinator.confirmClaim(testUserId, {});

      // Verify journal remains in 'committing' phase
      final journalRows = await offlineDb.database.query(
        'guest_claim_recovery_journal',
        where: 'claim_id = ?',
        whereArgs: [testClaimId],
      );
      expect(journalRows.length, equals(1));
      expect(journalRows.first['phase'], equals('committing'));

      // Invariant: Attempting to skip when commit is in indeterminate state throws StateError
      await expectLater(
        coordinator.skipClaim(testUserId),
        throwsA(isA<StateError>().having(
          (e) => e.message,
          'message',
          contains('Cannot skip claim once commit has started'),
        )),
      );

      // Account must not be resolved
      expect(fakeBridge.resolveCalls, isEmpty);
      expect(fakeBridge.pendingUnavailableCalls.length, equals(1));
    });

    test('15. Server COMMITTED, finalization == null -> does NOT purge guest or delete journal, keeps transitioning for recovery', () async {
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: DateTime.now().toUtc(),
      ));

      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      // Server returns COMMITTED with finalization: null
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimCommit(testClaimId),
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.guestClaimCommit(testClaimId)),
            statusCode: 200,
            data: {
              'claimId': testClaimId,
              'status': 'COMMITTED',
              'committedAt': '2026-10-14T12:00:00.000Z',
              'summary': standardCommitJson['summary'],
              'finalization': null,
            },
          ));

      final coordinator = createCoordinator();
      coordinator.currentClaimId = testClaimId;
      coordinator.currentUserId = testUserId;
      coordinator.isOpen = true;
      coordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);

      await coordinator.confirmClaim(testUserId, {});

      // Invariant: Guest partition and journal are NOT deleted (pending recovery)
      expect(await dao.hasGuestData('guest:$testGuestProfileId'), isTrue);
      final remainingJournal = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(remainingJournal, isNotEmpty);

      // Account is NOT resolved as claim completed
      expect(fakeBridge.resolveCalls, isEmpty);
      expect(coordinator.isPendingUnavailable, isTrue);
      expect(fakeBridge.pendingUnavailableCalls.length, equals(1));
    });

    test('16. Server COMMITTED, SQLite rebind error -> retains recovery context (committedServer), can retry', () async {
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: DateTime.now().toUtc(),
      ));
      // Omit saving history to cause metadata validation error during rebindScope!

      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimCommit(testClaimId),
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.guestClaimCommit(testClaimId)),
            statusCode: 200,
            data: standardCommitJson,
          ));

      final coordinator = createCoordinator();
      coordinator.currentClaimId = testClaimId;
      coordinator.currentUserId = testUserId;
      coordinator.isOpen = true;
      coordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);

      await coordinator.confirmClaim(testUserId, {});

      // SQLite rebind rolled back due to missing history metadata
      // But journal phase was transitioned to committedServer before rebind attempt!
      final journalRows = await offlineDb.database.query(
        'guest_claim_recovery_journal',
        where: 'claim_id = ?',
        whereArgs: [testClaimId],
      );
      expect(journalRows.length, equals(1));
      expect(journalRows.first['phase'], equals('committedServer'));

      // Account is NOT resolved
      expect(fakeBridge.resolveCalls, isEmpty);
      expect(coordinator.isPendingUnavailable, isTrue);
      expect(fakeBridge.pendingUnavailableCalls.length, equals(1));
    });

    test('17. 409 stale preview -> re-prepares, updates journal, and resets conflict decisions', () async {
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{"story-claim-1":"USE_GUEST"}',
        'phase': 'prepared',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimCommit(testClaimId),
            data: any<dynamic>(named: 'data'),
          )).thenThrow(DioException(
        requestOptions: RequestOptions(path: ApiEndpoints.guestClaimCommit(testClaimId)),
        response: Response(
          requestOptions: RequestOptions(path: ApiEndpoints.guestClaimCommit(testClaimId)),
          statusCode: 409,
          data: {'message': 'State fingerprint conflict'},
        ),
      ));

      final newPreviewJson = Map<String, dynamic>.from(standardPreviewJson);
      newPreviewJson['claimId'] = 're-prepared-claim-5555';
      newPreviewJson['stateFingerprint'] = 'c' * 64;

      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimPrepare,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response(
            requestOptions: RequestOptions(path: ApiEndpoints.guestClaimPrepare),
            statusCode: 200,
            data: newPreviewJson,
          ));

      final coordinator = createCoordinator();
      coordinator.currentClaimId = testClaimId;
      coordinator.currentUserId = testUserId;
      coordinator.isOpen = true;
      coordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);

      await coordinator.confirmClaim(testUserId, {'story-claim-1': ConflictResolution.useGuest});

      // Journal was replaced with new claimId and conflict_decisions reset to '{}'
      final journalRows = await offlineDb.database.query(
        'guest_claim_recovery_journal',
        where: 'claim_id = ?',
        whereArgs: ['re-prepared-claim-5555'],
      );
      expect(journalRows.length, equals(1));
      expect(journalRows.first['phase'], equals('prepared'));
      expect(journalRows.first['conflict_decisions'], equals('{}'));
      expect(journalRows.first['expected_state_fingerprint'], equals('c' * 64));
    });

    test('18. Auth user changed between prepare and commit -> Triple-check blocks resolve and does not rebind to wrong account', () async {
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: DateTime.now().toUtc(),
      ));

      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      final coordinator = createCoordinator();
      coordinator.currentClaimId = testClaimId;
      coordinator.currentUserId = testUserId;
      coordinator.activeGeneration = 1;
      coordinator.isOpen = true;
      coordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);

      // User logged out or switched to User B!
      fakeAuthService.updateUser(const User(
        id: 'user-b-9999',
        username: 'user_b',
        email: 'b@example.com',
        role: 'READER',
      ));

      await coordinator.confirmClaim(testUserId, {});

      // Invariant: Triple-check blocked commit, no HTTP call and no resolve
      verifyZeroInteractions(mockApiClient);
      expect(fakeBridge.resolveCalls, isEmpty);
    });

    test('19. Crash after SQLite commit before resolve -> restart checkAndPrepareClaim cleanly resolves without duplicate rebind or data loss', () async {
      // 1. Initial rebind completed: target has data, guest is purged, journal deleted
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'account:$testUserId',
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: DateTime.now().toUtc(),
      ));

      // Guest partition is empty (already purged)
      expect(await dao.hasGuestData('guest:$testGuestProfileId'), isFalse);
      // Journal is empty (already deleted in rebind transaction)
      expect(await offlineDb.database.query('guest_claim_recovery_journal'), isEmpty);

      // App crashed right before resolveToAccount was called.
      // Now app restarts, new coordinator instance created:
      final restartedCoordinator = createCoordinator();

      // On restart, checkCrashRecovery finds no journal
      await restartedCoordinator.checkCrashRecovery(testUserId);
      expect(restartedCoordinator.isOpen, isFalse);

      // checkAndPrepareClaim is called by bootstrap:
      await restartedCoordinator.checkAndPrepareClaim(testUserId);

      // Invariant: Since guest partition is already empty, immediately resolves to account without modal or error
      expect(restartedCoordinator.isOpen, isFalse);
      expect(fakeBridge.resolveCalls.length, equals(1));
      expect(fakeBridge.resolveCalls.first['userId'], equals(testUserId));
      verifyZeroInteractions(mockApiClient);
    });

    test('20. Stale commit response arrives when activeClaimId was cleared or changed to claim B -> callback is rejected even if generation unchanged', () async {
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': 1700000000000,
        'updated_at': 1700000000000,
      });

      final coordinator = createCoordinator();
      coordinator.currentClaimId = testClaimId;
      coordinator.currentUserId = testUserId;
      coordinator.activeGeneration = 1;
      coordinator.isOpen = true;
      coordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);

      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimCommit(testClaimId),
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async {
        // While request is in-flight, activeClaimId is reset to null (or switched to claim-B)
        coordinator.currentClaimId = null;
        return Response(
          requestOptions: RequestOptions(path: ApiEndpoints.guestClaimCommit(testClaimId)),
          statusCode: 200,
          data: standardCommitJson,
        );
      });

      await coordinator.confirmClaim(testUserId, {});

      // Invariant: Response A came late and activeClaimId was null (or claim-B).
      // Callback MUST BE REJECTED! No resolveToAccount call!
      expect(fakeBridge.resolveCalls, isEmpty);

      // Database journal was NOT transitioned to committedServer!
      final rows = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(rows.isNotEmpty, isTrue);
      expect(rows.first['phase'], isNot(equals('committedServer')));
    });

    test('21. Negative test: Prepare A in-flight -> claim session reset (_currentUserId = null) -> prepare A completes late -> rejected, no journal, modal stays closed', () async {
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: DateTime.now().toUtc(),
      ));

      final coordinator = createCoordinator();

      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimPrepare,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async {
        // Trong lúc prepare A đang in-flight, session bị reset (ví dụ resetSession hoặc user logout)
        coordinator.resetSession();
        return Response(
          requestOptions: RequestOptions(path: ApiEndpoints.guestClaimPrepare),
          statusCode: 200,
          data: standardPreviewJson,
        );
      });

      await coordinator.checkAndPrepareClaim(testUserId);

      // Invariant: Callback prepare A hoàn tất muộn bị từ chối nghiêm ngặt!
      expect(coordinator.isOpen, isFalse);
      expect(coordinator.previewData, isNull);

      // KHÔNG ĐƯỢC PHÉP ghi journal vào SQLite!
      final rows = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(rows, isEmpty);
    });

    test('22. Negative test: Two prepares for same user in same generation -> prepare A in-flight, prepare B started -> prepare A completes late -> rejected by operationId', () async {
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: DateTime.now().toUtc(),
      ));

      final coordinator = createCoordinator();

      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimPrepare,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async {
        // Mô phỏng prepare B chạy sau làm tăng activeOperationId
        coordinator.activeOperationId = 999;
        return Response(
          requestOptions: RequestOptions(path: ApiEndpoints.guestClaimPrepare),
          statusCode: 200,
          data: standardPreviewJson,
        );
      });

      await coordinator.checkAndPrepareClaim(testUserId);

      // Invariant: Prepare A hoàn tất muộn bị từ chối bởi operationId mismatch
      expect(coordinator.isOpen, isFalse);
      expect(coordinator.previewData, isNull);
      final rows = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(rows, isEmpty);
    });
  });
}


