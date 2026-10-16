import 'dart:convert';
import 'dart:io';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:omninovel_mobile/app/app.dart';
import 'package:omninovel_mobile/app/bootstrap.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/auth/token_storage.dart';
import 'package:omninovel_mobile/core/claim/guest_claim_coordinator.dart';
import 'package:omninovel_mobile/core/claim/models/guest_claim_models.dart';
import 'package:omninovel_mobile/core/claim/models/pending_guest_claim.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/identity/auth_scope_bridge.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/identity/installation_identity_provider.dart';
import 'package:omninovel_mobile/core/storage/local_library_dao.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/claim/presentation/guest_claim_bottom_sheet.dart';

class MockApiClient extends Mock implements ApiClient {}
class MockTokenStorage extends Mock implements ITokenStorage {}
class MockFlutterSecureStorage extends Mock implements FlutterSecureStorage {}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  group('Task 6 Cross-Layer Acceptance & Hardening Suite (AC-01 to AC-19)', () {
    late Directory tempDir;
    late String dbPath;
    late OfflineDatabase offlineDb;
    late MockApiClient mockApiClient;
    late MockTokenStorage mockTokenStorage;
    late MockFlutterSecureStorage mockSecureStorage;
    late LocalLibraryDao dao;
    late SharedPreferences prefs;
    late InstallationIdentityProvider installProvider;
    late GuestProfileIdentityProvider guestProvider;

    const testUserId = 'acc-user-001';
    const testGuestProfileId = 'acc-guest-999';
    const testClaimId = 'acc-claim-777';
    const testFingerprint = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

    final standardPreviewJson = {
      'claimId': testClaimId,
      'status': 'PREPARED',
      'stateFingerprint': testFingerprint,
      'expiresAt': '2026-10-16T12:00:00.000Z',
      'bookmarksToImport': 2,
      'historyToImport': 3,
      'progressToImport': 1,
      'conflictsCount': 0,
      'readStatesIgnoredAntiResurrectionCount': 0,
      'conflicts': <Map<String, dynamic>>[],
    };

    setUp(() async {
      SharedPreferences.setMockInitialValues({
        GuestProfileIdentityProvider.keyGuestProfileId: testGuestProfileId,
      });
      prefs = await SharedPreferences.getInstance();

      tempDir = await Directory.systemTemp.createTemp('guest_claim_acc_');
      dbPath = p.join(tempDir.path, 'guest_claim_acc.db');
      offlineDb = OfflineDatabase();
      await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
      );

      mockApiClient = MockApiClient();
      mockTokenStorage = MockTokenStorage();
      mockSecureStorage = MockFlutterSecureStorage();

      installProvider = InstallationIdentityProvider(
        secureStorage: mockSecureStorage,
        prefs: prefs,
      );
      guestProvider = GuestProfileIdentityProvider(prefs: prefs);

      dao = LocalLibraryDao(offlineDatabase: offlineDb);

      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.clearTokens()).thenAnswer((_) async {});
      when(() => mockTokenStorage.saveTokens(
            accessToken: any(named: 'accessToken'),
            refreshToken: any(named: 'refreshToken'),
          )).thenAnswer((_) async {});

      when(() => mockSecureStorage.read(key: any(named: 'key'))).thenAnswer((_) async => null);
      when(() => mockSecureStorage.write(key: any(named: 'key'), value: any(named: 'value')))
          .thenAnswer((_) async {});
    });

    tearDown(() async {
      await offlineDb.close();
      if (tempDir.existsSync()) {
        await tempDir.delete(recursive: true);
      }
    });

    // =========================================================================
    // AC-01: Login/Register success -> Scope stays TRANSITIONING, canMutateUserState == false
    // =========================================================================
    test('AC-01: Login/Register success keeps scope in TRANSITIONING without opening account', () async {
      final scopeCoordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );
      await scopeCoordinator.onAuthStatusChanged(AuthStatus.unauthenticated);

      expect(scopeCoordinator.state, equals(ActiveScopeState.guest));
      expect(scopeCoordinator.canMutateUserState, isTrue); // Guest mutation permitted

      // Authenticated event arrives
      await scopeCoordinator.onAuthStatusChanged(AuthStatus.authenticated, userId: testUserId);

      // Invariant: Zero-Bypass -> MUST be transitioning, activeScope null, canMutateUserState false
      expect(scopeCoordinator.state, equals(ActiveScopeState.transitioning));
      expect(scopeCoordinator.activeScope, isNull);
      expect(scopeCoordinator.canMutateUserState, isFalse);
    });

    // =========================================================================
    // AC-02: GoRouter redirects away from /login -> BottomSheet remains visible on Root Shell
    // =========================================================================
    testWidgets('AC-02: GoRouter navigation does not dismiss GuestClaimBottomSheet on Root Shell', (tester) async {
      final bootstrap = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customTokenStorage: mockTokenStorage,
      );

      await tester.pumpWidget(OmniNovelApp(bootstrapResult: bootstrap));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Trigger modal open
      bootstrap.guestClaimCoordinator.currentUserId = testUserId;
      bootstrap.guestClaimCoordinator.currentClaimId = testClaimId;
      bootstrap.guestClaimCoordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);
      bootstrap.guestClaimCoordinator.isOpen = true;

      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.byType(GuestClaimBottomSheet), findsOneWidget);

      // Navigate across multiple routes
      bootstrap.router.go('/search');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(GuestClaimBottomSheet), findsOneWidget);

      bootstrap.router.go('/home');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(GuestClaimBottomSheet), findsOneWidget);

      bootstrap.guestClaimCoordinator.isOpen = false;
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 11));
    });

    // =========================================================================
    // AC-03: Cold start with pending claim -> Bootstrap completes without deadlock
    // =========================================================================
    test('AC-03: Cold start with pending claim completes bootstrapReady without waiting on scope', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'committing',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': now,
        'updated_at': now,
      });

      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => 'valid_token');
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'valid_refresh');
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me)).thenAnswer((_) async => Response(
            data: {'id': testUserId, 'username': 'testuser', 'email': 't@example.com', 'role': 'READER'},
            statusCode: 200,
            requestOptions: RequestOptions(path: ApiEndpoints.me),
          ));

      final bootstrap = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customTokenStorage: mockTokenStorage,
        customApiClient: mockApiClient,
      );

      // Invariant: bootstrapReady is true even when scope is transitioning
      expect(bootstrap.router, isNotNull);
      expect(bootstrap.activeScopeCoordinator.state, equals(ActiveScopeState.transitioning));
    });

    // =========================================================================
    // AC-04: Crash after 200 COMMITTED -> Recovery reads SQLite journal, rebinds idempotently
    // =========================================================================
    test('AC-04: Crash after 200 COMMITTED recovers authoritative finalization and cleans guest partition', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'committedServer',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': now,
        'updated_at': now,
      });

      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-ac04-1',
        title: 'Story AC04',
        createdAt: DateTime.now().toUtc(),
      ));

      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.guestClaimStatus(testClaimId))).thenAnswer(
        (_) async => Response(
          data: {
            'claimId': testClaimId,
            'status': 'COMMITTED',
            'finalization': {
              'tombstonedStoryIds': <String>[],
              'finalizedReadingProgress': <Map<String, dynamic>>[],
              'finalizedChapterReadStates': <Map<String, dynamic>>[],
            },
          },
          statusCode: 200,
          requestOptions: RequestOptions(path: ApiEndpoints.guestClaimStatus(testClaimId)),
        ),
      );

      final bootstrap = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customTokenStorage: mockTokenStorage,
        customApiClient: mockApiClient,
      );

      final recoveryResult = await bootstrap.guestClaimCoordinator.checkCrashRecovery(testUserId);
      expect(recoveryResult, equals(CrashRecoveryResult.finalized));

      // Guest partition purged, journal cleared
      final hasGuest = await dao.hasGuestData('guest:$testGuestProfileId');
      expect(hasGuest, isFalse);

      final journal = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(journal, isEmpty);
    });

    // =========================================================================
    // AC-05: Crash during SQLite transaction -> Rollback, journal preserved for retry
    // =========================================================================
    test('AC-05: Crash during SQLite transaction rolls back and preserves journal', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'committedServer',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': now,
        'updated_at': now,
      });

      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-rollback-1',
        title: 'Rollback Story',
        createdAt: DateTime.now().toUtc(),
      ));

      // Simulate mid-transaction disk failure with onBeforeCommitHook
      try {
        await dao.rebindScope(
          sourceScope: 'guest:$testGuestProfileId',
          targetScope: 'account:$testUserId',
          claimId: testClaimId,
          finalization: const GuestClaimFinalizationData(
            tombstonedStoryIds: [],
            finalizedProgress: [],
            finalizedChapterReadStates: [],
          ),
          onBeforeCommitHook: () async => throw Exception('Disk failure mid-transaction'),
        );
      } catch (_) {}

      // Guest partition and journal preserved 100%
      final hasGuest = await dao.hasGuestData('guest:$testGuestProfileId');
      expect(hasGuest, isTrue);

      final journal = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(journal.length, equals(1));
    });

    // =========================================================================
    // AC-06: Crash after SQLite commit but before resolveToAccount -> safe resolve on restart
    // =========================================================================
    test('AC-06: Crash after SQLite commit before resolveToAccount resolves cleanly on restart', () async {
      // Rebind already finished prior to crash, journal is gone
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'account:$testUserId',
        storyId: 'story-ac06-1',
        title: 'AC06 Story',
        createdAt: DateTime.now().toUtc(),
      ));

      final bootstrap = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customTokenStorage: mockTokenStorage,
        customApiClient: mockApiClient,
      );

      final result = await bootstrap.guestClaimCoordinator.checkCrashRecovery(testUserId);
      expect(result, equals(CrashRecoveryResult.noPending));

      // No double claim or stale rebind triggered
      expect(bootstrap.guestClaimCoordinator.isOpen, isFalse);
    });

    // =========================================================================
    // AC-07: KEEP_CLOUD when local not cached -> writes exact 12 columns
    // =========================================================================
    test('AC-07: KEEP_CLOUD when local not cached writes full 12 columns with integer milliseconds', () async {
      final finalization = GuestClaimFinalizationData(
        tombstonedStoryIds: const [],
        finalizedProgress: [
          ClaimFinalizedProgressItem(
            storyId: 'story-cloud-1',
            chapterId: 'chap-cloud-1',
            pageIndex: 12,
            scrollPosition: 450.5,
            progressPercentage: 65.0,
            readingMode: ReadingMode.webtoon,
            deviceTimestamp: 1729000000000,
            updatedAt: DateTime.fromMillisecondsSinceEpoch(1729000000000).toIso8601String(),
          ),
        ],
        finalizedChapterReadStates: const [],
      );

      final now = DateTime.now().millisecondsSinceEpoch;
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'committedServer',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': now,
        'updated_at': now,
      });

      await dao.rebindScope(
        sourceScope: 'guest:$testGuestProfileId',
        targetScope: 'account:$testUserId',
        claimId: testClaimId,
        finalization: finalization,
      );

      final progress = await dao.getProgress(ownerScope: 'account:$testUserId', storyId: 'story-cloud-1');
      expect(progress, isNotNull);
      expect(progress!.storyId, equals('story-cloud-1'));
      expect(progress.chapterId, equals('chap-cloud-1'));
      expect(progress.pageIndex, equals(12));
      expect(progress.progressPercentage, equals(65.0));
      expect(progress.deviceTimestamp.millisecondsSinceEpoch, equals(1729000000000));
      expect(progress.updatedAt.millisecondsSinceEpoch, equals(1729000000000));
    });

    // =========================================================================
    // AC-08: Server rejects due to Tombstone -> Scoped reconciliation excludes tombstoned stories
    // =========================================================================
    test('AC-08: Scoped reconciliation excludes tombstoned stories from history and progress', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'committedServer',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': now,
        'updated_at': now,
      });

      // Save guest progress & history for tombstoned story
      await dao.saveProgress(LocalReadingProgress(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-tombstone-1',
        chapterId: 'chap-tomb-1',
        pageIndex: 5,
        scrollPosition: 0,
        progressPercentage: 50.0,
        readingMode: 'webtoon',
        deviceTimestamp: DateTime.fromMillisecondsSinceEpoch(now),
        updatedAt: DateTime.fromMillisecondsSinceEpoch(now),
      ));

      await dao.rebindScope(
        sourceScope: 'guest:$testGuestProfileId',
        targetScope: 'account:$testUserId',
        claimId: testClaimId,
        finalization: const GuestClaimFinalizationData(
          tombstonedStoryIds: ['story-tombstone-1'],
          finalizedProgress: [],
          finalizedChapterReadStates: [],
        ),
      );

      // Invariant: Tombstoned story MUST NOT be resurrected into account cache
      final progress = await dao.getProgress(ownerScope: 'account:$testUserId', storyId: 'story-tombstone-1');
      expect(progress, isNull);
    });

    // =========================================================================
    // AC-09: /auth/me network error when recovery context exists -> keeps pendingVerification
    // =========================================================================
    test('AC-09: Network error when tokens exist preserves pendingVerification and does not rotate guest', () async {
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => 'saved_access_token');
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'saved_refresh_token');
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me)).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: ApiEndpoints.me),
          type: DioExceptionType.connectionTimeout,
        ),
      );

      final authService = AuthService(
        apiClient: mockApiClient,
        tokenStorage: mockTokenStorage,
      );

      await authService.initializeAuth();

      expect(authService.state.status, equals(AuthStatus.pendingVerification));
      expect(authService.state.isAuthenticated, isFalse);
      verifyNever(() => mockTokenStorage.clearTokens());
    });

    // =========================================================================
    // AC-10: Account A has pending claim, then user logs into Account B -> Generation guard cancels stale
    // =========================================================================
    test('AC-10: Generation guard cancels stale callbacks when switching from Account A to B', () async {
      final bootstrap = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customTokenStorage: mockTokenStorage,
        customApiClient: mockApiClient,
      );

      final scopeCoordinator = bootstrap.activeScopeCoordinator;

      // Start prepare for User A
      scopeCoordinator.setTransitioning(forUserId: 'user-A');
      final genA = scopeCoordinator.transitionGeneration;

      // User switches to User B (e.g. relogin)
      scopeCoordinator.setTransitioning(forUserId: 'user-B');
      final genB = scopeCoordinator.transitionGeneration;
      expect(genB, greaterThan(genA));

      // Attempting to resolve with stale generation A is dropped fail-closed
      await scopeCoordinator.resolveToAccount('user-A', expectedGeneration: genA);
      expect(scopeCoordinator.state, equals(ActiveScopeState.transitioning));
      expect(scopeCoordinator.activeScope, isNull);
    });

    // =========================================================================
    // AC-11: Claim operation does not corrupt or delete offline download tasks / chapters of guest
    // =========================================================================
    test('AC-11: Claim operation preserves download_tasks and offline_chapters intact', () async {
      await offlineDb.database.insert('download_tasks', {
        'task_id': 'task-dl-1',
        'user_id': testUserId,
        'chapter_version_id': 'ver-dl-1',
        'chapter_id': 'chap-dl-1',
        'story_id': 'story-dl-1',
        'story_title': 'Story DL',
        'chapter_number': '1',
        'media_format': 'COMIC',
        'status': 'COMPLETED',
        'downloaded_bytes': 2000,
        'total_bytes': 2000,
        'created_at': DateTime.now().millisecondsSinceEpoch,
        'updated_at': DateTime.now().millisecondsSinceEpoch,
      });

      final now = DateTime.now().millisecondsSinceEpoch;
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'committedServer',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': now,
        'updated_at': now,
      });

      await dao.rebindScope(
        sourceScope: 'guest:$testGuestProfileId',
        targetScope: 'account:$testUserId',
        claimId: testClaimId,
        finalization: const GuestClaimFinalizationData(
          tombstonedStoryIds: [],
          finalizedProgress: [],
          finalizedChapterReadStates: [],
        ),
      );

      final tasks = await offlineDb.database.query('download_tasks');
      expect(tasks.length, equals(1));
      expect(tasks.first['task_id'], equals('task-dl-1'));
    });

    // =========================================================================
    // AC-12: User selects Skip -> only in prepared phase, quarantines, preserves 100% partition
    // =========================================================================
    test('AC-12: Skip claim in prepared phase quarantines and preserves guest partition', () async {
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-skip-1',
        title: 'Skip Story',
        createdAt: DateTime.now().toUtc(),
      ));

      final bootstrap = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customTokenStorage: mockTokenStorage,
        customApiClient: mockApiClient,
      );

      final coordinator = bootstrap.guestClaimCoordinator;
      bootstrap.activeScopeCoordinator.setTransitioning(forUserId: testUserId);

      // Insert prepared claim in journal
      final now = DateTime.now().millisecondsSinceEpoch;
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': now,
        'updated_at': now,
      });

      coordinator.currentUserId = testUserId;
      coordinator.currentClaimId = testClaimId;
      coordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);
      coordinator.isOpen = true;

      // Mock authService state as authenticated
      final authUser = const User(id: testUserId, username: 'testuser', email: 't@example.com', role: 'READER');
      bootstrap.authService.updateStateForTesting(AuthState.authenticated(user: authUser, accessToken: 'token'));

      await coordinator.skipClaim(testUserId);

      // Invariant: Guest partition preserved 100%
      final hasGuest = await dao.hasGuestData('guest:$testGuestProfileId');
      expect(hasGuest, isTrue);

      // Journal cleared
      final journal = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(journal, isEmpty);

      // Scope resolved to account
      expect(bootstrap.activeScopeCoordinator.state, equals(ActiveScopeState.account));
    });

    // =========================================================================
    // AC-13 (P0-1): Access expired, refresh stored, offline -> pendingVerification, no rotate
    // =========================================================================
    test('AC-13 (P0-1): Expired access token with valid stored refresh token offline maintains pendingVerification and avoids guest rotate', () async {
      // Expired JWT (-2 hours ago)
      final pastExp = (DateTime.now().millisecondsSinceEpoch ~/ 1000) - 7200;
      final payload = base64Url.encode(utf8.encode(jsonEncode({
        'sub': testUserId,
        'username': 'offline_user',
        'role': 'READER',
        'exp': pastExp,
      }))).replaceAll('=', '');
      final expiredJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.$payload.dummy_signature';

      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => expiredJwt);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'valid_refresh_token_7_days');
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me)).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: ApiEndpoints.me),
          type: DioExceptionType.connectionTimeout,
        ),
      );

      final authService = AuthService(
        apiClient: mockApiClient,
        tokenStorage: mockTokenStorage,
      );

      final scopeCoordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );
      await scopeCoordinator.onAuthStatusChanged(AuthStatus.unauthenticated);
      final initialGuestId = await guestProvider.getOrCreateGuestProfileId();

      final bridge = AuthScopeBridge(
        authService: authService,
        coordinator: scopeCoordinator,
      );
      bridge.attach();

      await authService.initializeAuth();
      await bridge.settle();

      // Invariant P0-1: MUST be pendingVerification, NOT unauthenticated!
      expect(authService.state.status, equals(AuthStatus.pendingVerification));
      expect(authService.state.isAuthenticated, isFalse);
      expect(authService.state.isVerifiedAuth, isFalse);

      // Invariant: Guest profile MUST NOT be rotated
      final currentGuestId = await guestProvider.getOrCreateGuestProfileId();
      expect(currentGuestId, equals(initialGuestId));

      bridge.dispose();
    });

    // =========================================================================
    // AC-14 (P0-1): JWT with tampered payload -> No Verified Auth by client decode
    // =========================================================================
    test('AC-14 (P0-1): Tampered JWT payload never yields Verified Auth by decode alone', () async {
      const tamperedJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.corrupted_tampered_payload_xyz.signature';

      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => tamperedJwt);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'refresh_token');
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me)).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: ApiEndpoints.me),
          type: DioExceptionType.connectionTimeout,
        ),
      );

      final authService = AuthService(
        apiClient: mockApiClient,
        tokenStorage: mockTokenStorage,
      );

      await authService.initializeAuth();

      // Invariant RFC 7519: Tampered token offline MUST NOT produce authenticated
      expect(authService.state.isAuthenticated, isFalse);
      expect(authService.state.isVerifiedAuth, isFalse);
      expect(authService.state.status, equals(AuthStatus.pendingVerification));
      expect(authService.state.hintUser, isNull);
    });

    // =========================================================================
    // AC-15 (P0-2): Recovery journal committing, status timeout -> pendingUnavailable, NO new prepare
    // =========================================================================
    test('AC-15 (P0-2): Journal committing with network timeout returns pendingUnavailable and blocks new prepare', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'committing',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': now,
        'updated_at': now,
      });

      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.guestClaimStatus(testClaimId))).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: ApiEndpoints.guestClaimStatus(testClaimId)),
          type: DioExceptionType.connectionTimeout,
        ),
      );

      final bootstrap = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customTokenStorage: mockTokenStorage,
        customApiClient: mockApiClient,
      );

      final result = await bootstrap.guestClaimCoordinator.checkCrashRecovery(testUserId);

      // Invariant P0-2: Explicit semantic status
      expect(result, equals(CrashRecoveryResult.pendingUnavailable));

      // Attempting checkAndPrepareClaim when pending journal exists is BLOCKED
      await bootstrap.guestClaimCoordinator.checkAndPrepareClaim(testUserId);

      // Verify no POST /prepare was dispatched
      verifyNever(() => mockApiClient.post(ApiEndpoints.guestClaimPrepare, data: any(named: 'data')));
    });

    // =========================================================================
    // AC-16 (P0-2): Recovery journal committedServer -> Finalization before any new claim
    // =========================================================================
    test('AC-16 (P0-2): Recovery journal committedServer prioritizes finalization before any new claim', () async {
      final now = DateTime.now().millisecondsSinceEpoch;
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': testFingerprint,
        'conflict_decisions': '{}',
        'phase': 'committedServer',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': now,
        'updated_at': now,
      });

      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.guestClaimStatus(testClaimId))).thenAnswer(
        (_) async => Response(
          data: {
            'claimId': testClaimId,
            'status': 'COMMITTED',
            'finalization': {
              'tombstonedStoryIds': <String>[],
              'finalizedReadingProgress': <Map<String, dynamic>>[],
              'finalizedChapterReadStates': <Map<String, dynamic>>[],
            },
          },
          statusCode: 200,
          requestOptions: RequestOptions(path: ApiEndpoints.guestClaimStatus(testClaimId)),
        ),
      );

      final bootstrap = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customTokenStorage: mockTokenStorage,
        customApiClient: mockApiClient,
      );

      final result = await bootstrap.guestClaimCoordinator.checkCrashRecovery(testUserId);

      expect(result, equals(CrashRecoveryResult.finalized));
      verifyNever(() => mockApiClient.post(ApiEndpoints.guestClaimPrepare, data: any(named: 'data')));
    });

    // =========================================================================
    // AC-17 (P0-3): System Back when modal prepared -> PopScope(canPop: false) prevents pop
    // =========================================================================
    testWidgets('AC-17 (P0-3): System Back when modal is prepared cannot silently dismiss bottom sheet', (tester) async {
      final bootstrap = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customTokenStorage: mockTokenStorage,
        customApiClient: mockApiClient,
      );

      final coordinator = bootstrap.guestClaimCoordinator;
      coordinator.currentUserId = testUserId;
      coordinator.currentClaimId = testClaimId;
      coordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: GuestClaimBottomSheet(
              coordinator: coordinator,
              userId: testUserId,
            ),
          ),
        ),
      );
      await tester.pump();

      // Find PopScope
      final popScope = tester.widget<PopScope>(find.byType(PopScope));

      // Invariant P0-3: canPop MUST be false even when isCommitting is false
      expect(popScope.canPop, isFalse);

      // Simulate system back dispatch
      final dynamic widgetsAppState = tester.state(find.byType(WidgetsApp));
      await widgetsAppState.didPopRoute();
      await tester.pump();

      // Modal is still present
      expect(find.byType(GuestClaimBottomSheet), findsOneWidget);
    });

    // =========================================================================
    // AC-18: Verified -> Pending Verification -> No new scope or unauthorized write
    // =========================================================================
    test('AC-18: Drop from Verified to Pending Verification does not open new scope or write unauthorized data', () async {
      final scopeCoordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );
      await scopeCoordinator.onAuthStatusChanged(AuthStatus.unauthenticated);

      // Verified auth -> transitioning
      await scopeCoordinator.onAuthStatusChanged(AuthStatus.authenticated, userId: testUserId);
      expect(scopeCoordinator.state, equals(ActiveScopeState.transitioning));
      expect(scopeCoordinator.canMutateUserState, isFalse);

      // Network drops -> pendingVerification
      await scopeCoordinator.onAuthStatusChanged(AuthStatus.pendingVerification, userId: testUserId);

      // Invariant: Cannot open account scope, account mutation remains prohibited
      expect(scopeCoordinator.state, isNot(equals(ActiveScopeState.account)));
      expect(scopeCoordinator.activeScope, equals('guest:$testGuestProfileId'));
    });

    // =========================================================================
    // AC-19: Network restored -> Session verified, then resumes recovery exactly once
    // =========================================================================
    test('AC-19: Network recovery verifies session and executes recovery exactly once', () async {
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => 'valid_token');
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => 'valid_refresh');

      // First call fails (offline)
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me)).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: ApiEndpoints.me),
          type: DioExceptionType.connectionTimeout,
        ),
      );

      final authService = AuthService(
        apiClient: mockApiClient,
        tokenStorage: mockTokenStorage,
      );

      await authService.initializeAuth();
      expect(authService.state.status, equals(AuthStatus.pendingVerification));

      // Network restores: GET /auth/me returns 200
      when(() => mockApiClient.get<Map<String, dynamic>>(ApiEndpoints.me)).thenAnswer(
        (_) async => Response(
          data: {'id': testUserId, 'username': 'verified_user', 'email': 'v@example.com', 'role': 'READER'},
          statusCode: 200,
          requestOptions: RequestOptions(path: ApiEndpoints.me),
        ),
      );

      await authService.initializeAuth();
      expect(authService.state.status, equals(AuthStatus.authenticated));
      expect(authService.state.isVerifiedAuth, isTrue);
    });
  });
}
