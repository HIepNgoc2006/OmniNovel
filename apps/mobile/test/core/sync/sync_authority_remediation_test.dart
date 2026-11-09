import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/auth/token_storage.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/identity/auth_scope_bridge.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/identity/installation_identity_provider.dart';
import 'package:omninovel_mobile/core/storage/local_library_dao.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/storage/preferences_service.dart';
import 'package:omninovel_mobile/core/sync/authority/sync_client_identity_provider.dart';
import 'package:omninovel_mobile/core/sync/authority/sync_write_admission.dart';
import 'package:omninovel_mobile/core/sync/errors/sync_storage_exceptions.dart';
import 'package:omninovel_mobile/core/sync/models/sync_models.dart';
import 'package:omninovel_mobile/core/sync/storage/sync_storage_dal.dart';
import 'package:omninovel_mobile/core/sync/utils/canonical_entity_key.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'sync_test_helpers.dart';

class _MockApiClient extends Mock implements ApiClient {}

class _MockTokenStorage extends Mock implements ITokenStorage {}

class _MockSecureStorage extends Mock implements FlutterSecureStorage {}

class _SpoofableAccountAdmission implements AccountWriteAdmission {
  @override
  final String authorizedScope;

  @override
  final String expectedUserId;

  @override
  final int expectedGeneration;

  _SpoofableAccountAdmission(String guestScope)
      : authorizedScope = guestScope,
        expectedUserId = 'spoof',
        expectedGeneration = 1;

  @override
  void assertAdmitted(String targetScope) {}
}

String _encodeJwt(Map<String, Object?> payload) {
  final header = base64Url.encode(utf8.encode(jsonEncode(<String, Object?>{'alg': 'HS256', 'typ': 'JWT'})));
  final body = base64Url.encode(utf8.encode(jsonEncode(payload)));
  return '$header.$body.sig';
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  late Directory tempDir;
  late String dbPath;
  late OfflineDatabase offlineDb;
  late SyncStorageDal dal;
  late LocalLibraryDao localDao;
  late SharedPreferences prefs;

  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    prefs = await SharedPreferences.getInstance();

    tempDir = await Directory.systemTemp.createTemp('omninovel_remediation_');
    dbPath = p.join(tempDir.path, 'remediation.db');
    offlineDb = OfflineDatabase();
    await offlineDb.initialize(
      customPath: dbPath,
      databaseFactory: databaseFactoryFfi,
      singleInstance: false,
    );
    dal = SyncStorageDal(offlineDatabase: offlineDb);
    localDao = LocalLibraryDao(offlineDatabase: offlineDb);
  });

  tearDown(() async {
    try {
      await offlineDb.close();
      await databaseFactoryFfi.deleteDatabase(dbPath);
    } catch (_) {}
    try {
      if (await tempDir.exists()) {
        await tempDir.delete(recursive: true);
      }
    } catch (_) {}
  });

  group('P0-M05: Guest / Account Authority Boundary & Lifecycle Purge', () {
    test('rejects guest:* scopes on ALL Account Sync reads and writes with InvalidSyncScopeException', () async {
      const guestScope = 'guest:guest-authority-blocked';
      final spoofedAdmission = _SpoofableAccountAdmission(guestScope);
      final now = DateTime.utc(2026, 2, 1);

      final progress = LocalReadingProgress(
        ownerScope: guestScope,
        storyId: 's-1',
        chapterId: 'c-1',
        readingMode: 'WEBTOON',
        progressPercentage: 40.0,
        scrollPosition: 20.0,
        updatedAt: now,
        deviceTimestamp: now,
      );
      final history = LocalReadingHistory(
        ownerScope: guestScope,
        storyId: 's-1',
        chapterId: 'c-1',
        storyTitle: 'Title',
        chapterNumber: '1',
        progressPercentage: 40.0,
        lastReadAt: now,
      );
      final mutation = PendingMutationRecord.create(
        ownerScope: guestScope,
        mutationId: 'mut-guest-illegal',
        clientId: kTestClientId,
        domain: SyncDomain.progress,
        entityId: 's-1',
        operation: SyncOperation.upsert,
        baseServerRevision: '0',
        payload: buildSyncProgressPayload(progress),
        createdAt: now,
      );

      final ops = <Future<Object?> Function()>[
        () => dal.recordReadingSessionWithMutation(
              progress: progress,
              history: history,
              mutation: mutation,
              admission: spoofedAdmission,
            ),
        () => dal.putBookmarkWithMutation(
              bookmark: LocalBookmark(ownerScope: guestScope, storyId: 's-1', title: 'BM', createdAt: now),
              mutation: mutation.copyWith(domain: SyncDomain.bookmark),
              admission: spoofedAdmission,
            ),
        () => dal.deleteBookmarkWithMutation(
              ownerScope: guestScope,
              storyId: 's-1',
              mutation: mutation.copyWith(domain: SyncDomain.bookmark, operation: SyncOperation.delete),
              admission: spoofedAdmission,
            ),
        () => dal.putPreferenceWithMutation(
              preference: LocalPreferenceRecord(
                ownerScope: guestScope,
                prefKey: 'theme',
                value: 'dark',
                updatedAt: now.toIso8601String(),
              ),
              mutation: mutation.copyWith(domain: SyncDomain.preference, entityId: 'theme'),
              admission: spoofedAdmission,
            ),
        () => dal.deleteStoryHistoryWithMutation(
              ownerScope: guestScope,
              storyId: 's-1',
              mutation: mutation.copyWith(domain: SyncDomain.history, operation: SyncOperation.delete),
              admission: spoofedAdmission,
            ),
        () => dal.clearAllHistoryWithMutation(
              ownerScope: guestScope,
              mutation: mutation.copyWith(
                domain: SyncDomain.history,
                operation: SyncOperation.delete,
                entityId: kGlobalHistorySentinelUuid,
              ),
              admission: spoofedAdmission,
            ),
        () => dal.enqueuePendingMutation(mutation, admission: spoofedAdmission),
        () => dal.getPendingMutation(guestScope, 'mut-guest-illegal'),
        () => dal.getPendingMutations(guestScope),
        () => dal.deletePendingMutation(guestScope, 'mut-1', admission: spoofedAdmission),
        () => dal.deletePendingMutationsBatch(guestScope, <String>['mut-1'], admission: spoofedAdmission),
        () => dal.recordTransientFailureAtomic(
              ownerScope: guestScope,
              mutationId: 'mut-1',
              options: const RecordTransientFailureOptions(
                maxRetries: 3,
                initialBackoffMs: 100,
                maxBackoffMs: 1000,
                backoffFactor: 2,
                failureReason: 'err',
              ),
              admission: spoofedAdmission,
            ),
        () => dal.quarantinePendingMutationByKey(
              ownerScope: guestScope,
              mutationId: 'mut-1',
              reason: 'reason',
              admission: spoofedAdmission,
            ),
        () => dal.quarantineMutation(
              QuarantinedMutationRecord(
                ownerScope: guestScope,
                mutationId: 'mut-q',
                clientId: kTestClientId,
                domain: SyncDomain.bookmark,
                entityId: 's-1',
                operation: SyncOperation.upsert,
                baseServerRevision: '0',
                payload: const <String, Object?>{},
                originalCreatedAtIso: now.toIso8601String(),
                originalCreatedAtMs: now.millisecondsSinceEpoch,
                rejectionReason: 'manual',
                rejectedAtIso: now.toIso8601String(),
                rejectedAtMs: now.millisecondsSinceEpoch,
              ),
              admission: spoofedAdmission,
            ),
        () => dal.getQuarantinedMutation(guestScope, 'mut-q'),
        () => dal.getQuarantinedMutations(guestScope),
        () => dal.deleteQuarantinedMutation(guestScope, 'mut-q', admission: spoofedAdmission),
        () => dal.requeueQuarantinedMutation(
              ownerScope: guestScope,
              mutationId: 'mut-q',
              admission: spoofedAdmission,
            ),
        () => dal.evictReplicaAndRemovePending(
              ownerScope: guestScope,
              domain: SyncDomain.bookmark,
              entityId: 's-1',
              mutationId: 'mut-1',
              admission: spoofedAdmission,
            ),
        () => dal.getAccountLocalPreference(guestScope, 'theme'),
        () => dal.getAllAccountLocalPreferences(guestScope),
        () => dal.getSyncMeta(guestScope),
        () => dal.putSyncMeta(
              SyncMeta(ownerScope: guestScope, lastSyncTimestamp: now.toIso8601String()),
              admission: spoofedAdmission,
            ),
        () => dal.getAuthoritativeBaselineStatus(guestScope),
        () => dal.setAuthoritativeBaselineStatus(
              guestScope,
              AuthoritativeBaselineStatus.bootstrapping,
              admission: spoofedAdmission,
            ),
        () => dal.isAuthoritativeReady(guestScope),
        () => dal.recoverInterruptedBootstrapToUninitialized(
              guestScope,
              admission: spoofedAdmission,
            ),
        () => dal.getAuthoritativeShadow(guestScope, SyncDomain.bookmark, 's-1'),
        () => dal.getAuthoritativeShadowsByDomain(guestScope, SyncDomain.bookmark),
        () => dal.getAllAuthoritativeShadows(guestScope),
        () => dal.applyAuthoritativeDeltaPage(
              ownerScope: guestScope,
              expectedCheckpoint: '0',
              admission: spoofedAdmission,
              page: const SyncChangesPage(
                currentServerRevision: '1',
                minActiveRevision: '0',
                nextRevision: null,
                hasMore: false,
                changes: <SyncChangeItem>[],
              ),
            ),
        () => dal.stageSnapshotItems(
              ownerScope: guestScope,
              admission: spoofedAdmission,
              items: <SnapshotStagingItem>[
                SnapshotStagingItem(
                  ownerScope: guestScope,
                  sessionId: 'sess',
                  snapshotRevision: '1',
                  minActiveRevision: '0',
                  domain: SyncDomain.bookmark,
                  entityKey: 's-1',
                  payload: const <String, Object?>{},
                  stagedAtIso: now.toIso8601String(),
                  stagedAtMs: now.millisecondsSinceEpoch,
                ),
              ],
            ),
        () => dal.getSnapshotStagingItems(guestScope, 'sess'),
        () => dal.clearSnapshotStaging(guestScope, admission: spoofedAdmission),
        () => dal.purgeAccountScope(
              ownerScope: guestScope,
              reason: AccountPurgeReason.signOutReset,
              admission: spoofedAdmission,
            ),
      ];

      for (var i = 0; i < ops.length; i++) {
        await expectLater(
          ops[i],
          throwsA(isA<InvalidSyncScopeException>()),
          reason: 'Account Sync op index $i failed to reject guest scope',
        );
      }

      for (final table in <String>[
        'sync_meta',
        'sync_mutation_sequences',
        'sync_authoritative_replicas',
        'pending_mutations',
        'quarantined_mutations',
        'snapshot_staging_store',
        'local_preferences',
      ]) {
        expect(
          await offlineDb.database.query(
            table,
            where: 'owner_scope = ?',
            whereArgs: <Object?>[guestScope],
          ),
          isEmpty,
        );
      }
    });

    test('explicitly isolates Guest-local preferences and rejects account:* scopes on Guest APIs', () async {
      const guestScope = 'guest:g-pref-1';
      const accountScope = 'account:user-1';
      final guestAdmission = testGuestAdmission(guestScope);
      final nowIso = DateTime.utc(2026, 2, 1).toIso8601String();

      await dal.putGuestLocalPreference(
        LocalPreferenceRecord(
          ownerScope: guestScope,
          prefKey: 'reader_mode',
          value: 'sepia',
          updatedAt: nowIso,
        ),
        admission: guestAdmission,
      );

      expect((await dal.getGuestLocalPreference(guestScope, 'reader_mode'))?.value, 'sepia');
      expect(await dal.getAllGuestLocalPreferences(guestScope), hasLength(1));

      await dal.deleteGuestLocalPreference(guestScope, 'reader_mode', admission: guestAdmission);
      expect(await dal.getGuestLocalPreference(guestScope, 'reader_mode'), isNull);

      // Account scope cannot call Guest-local preference APIs
      await expectLater(
        () => dal.getGuestLocalPreference(accountScope, 'reader_mode'),
        throwsA(isA<InvalidSyncScopeException>()),
      );
      await expectLater(
        () => dal.getAllGuestLocalPreferences(accountScope),
        throwsA(isA<InvalidSyncScopeException>()),
      );
      await expectLater(
        () => dal.putGuestLocalPreference(
          LocalPreferenceRecord(
            ownerScope: accountScope,
            prefKey: 'reader_mode',
            value: 'sepia',
            updatedAt: nowIso,
          ),
          admission: GuestLocalWriteAdmission(
            authoritySource: MutableSyncAuthoritySource.activeAccount('user-1'),
            expectedGuestProfileId: 'g-pref-1',
            expectedGeneration: 1,
          ),
        ),
        throwsA(isA<InvalidSyncScopeException>()),
      );
      await expectLater(
        () => dal.purgeGuestLocalScope(
          guestScope: accountScope,
          reason: GuestLifecyclePurgeReason.userClearedGuestData,
          admission: guestAdmission,
          guestProfileProvider: GuestProfileIdentityProvider(prefs: prefs),
        ),
        throwsA(isA<InvalidSyncScopeException>()),
      );
    });

    test('purgeGuestLocalScope blocks quarantined & claim-journal guests (PurgeProhibitedError) and cleans unclaimed guests safely', () async {
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      const safeGuestId = 'g-safe-unclaimed';
      const safeGuestScope = 'guest:$safeGuestId';
      const journalGuestId = 'g-in-claim-journal';
      const journalGuestScope = 'guest:$journalGuestId';
      const quarantinedGuestId = 'g-quarantined';
      const quarantinedGuestScope = 'guest:$quarantinedGuestId';
      const accountScope = 'account:safe-owner';

      final db = offlineDb.database;
      final t = DateTime.utc(2026, 2, 1);

      // Seed data for safeGuestScope, journalGuestScope, quarantinedGuestScope, accountScope
      for (final gScope in <String>[safeGuestScope, journalGuestScope, quarantinedGuestScope]) {
        await localDao.saveBookmark(
          LocalBookmark(ownerScope: gScope, storyId: 's-1', title: 'Story', createdAt: t),
        );
        await dal.putGuestLocalPreference(
          LocalPreferenceRecord(
            ownerScope: gScope,
            prefKey: 'theme',
            value: 'light',
            updatedAt: t.toIso8601String(),
          ),
          admission: testGuestAdmission(gScope),
        );
      }
      await dal.putBookmarkWithMutation(
        bookmark: LocalBookmark(ownerScope: accountScope, storyId: 's-acc', title: 'Acc', createdAt: t),
        mutation: PendingMutationRecord.create(
          ownerScope: accountScope,
          mutationId: 'mut-acc-keep',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 's-acc',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 's-acc'},
          createdAt: t,
        ),
        admission: testAccountAdmission(accountScope),
      );
      await db.insert('offline_chapters', <String, Object?>{
        'chapter_version_id': 'cv-1',
        'user_id': 'safe-owner',
        'chapter_id': 'c-1',
        'story_id': 's-1',
        'story_title': 'Keep',
        'chapter_number': '1',
        'media_format': 'WEBTOON',
        'installed_dir': '/keep',
        'total_files': 1,
        'total_bytes': 10,
        'installed_at': 1000,
        'manifest_json': '{}',
      });

      // 1. Quarantine blocks purgeGuestLocalScope
      await guestProvider.quarantineGuestScope(quarantinedGuestId);
      await expectLater(
        () => dal.purgeGuestLocalScope(
          guestScope: quarantinedGuestScope,
          reason: GuestLifecyclePurgeReason.userClearedGuestData,
          admission: testGuestAdmission(quarantinedGuestScope),
          guestProfileProvider: guestProvider,
        ),
        throwsA(isA<PurgeProhibitedError>()),
      );
      expect(await localDao.isBookmarked(ownerScope: quarantinedGuestScope, storyId: 's-1'), isTrue);

      // 2. Any guest_claim_recovery_journal phase ('prepared', 'committing', 'committedServer') blocks purge
      for (final phase in <String>['prepared', 'committing', 'committedServer']) {
        await db.insert(
          'guest_claim_recovery_journal',
          <String, Object?>{
            'claim_id': 'claim-$phase',
            'user_id': 'safe-owner',
            'guest_profile_id': journalGuestId,
            'expected_state_fingerprint': 'fp',
            'conflict_decisions': '{}',
            'phase': phase,
            'created_at': 1000,
            'updated_at': 1000,
          },
          conflictAlgorithm: ConflictAlgorithm.replace,
        );

        await expectLater(
          () => dal.purgeGuestLocalScope(
            guestScope: journalGuestScope,
            reason: GuestLifecyclePurgeReason.verifiedUnusedGuestEviction,
            admission: testGuestAdmission(journalGuestScope),
            guestProfileProvider: guestProvider,
          ),
          throwsA(isA<PurgeProhibitedError>()),
          reason: 'Should prohibit purge during claim phase=$phase',
        );
        expect(await localDao.isBookmarked(ownerScope: journalGuestScope, storyId: 's-1'), isTrue);

        await db.delete(
          'guest_claim_recovery_journal',
          where: 'claim_id = ?',
          whereArgs: <Object?>['claim-$phase'],
        );
      }

      // 3. Unclaimed & non-quarantined guest purge deletes ONLY local_* of safeGuestScope
      await dal.purgeGuestLocalScope(
        guestScope: safeGuestScope,
        reason: GuestLifecyclePurgeReason.userClearedGuestData,
        admission: testGuestAdmission(safeGuestScope),
        guestProfileProvider: guestProvider,
      );
      expect(await localDao.getBookmarks(ownerScope: safeGuestScope), isEmpty);
      expect(await dal.getGuestLocalPreference(safeGuestScope, 'theme'), isNull);

      // Quarantined guest, journal guest, account data, and offline_chapters untouched!
      expect(await localDao.isBookmarked(ownerScope: quarantinedGuestScope, storyId: 's-1'), isTrue);
      expect(await localDao.isBookmarked(ownerScope: journalGuestScope, storyId: 's-1'), isTrue);
      expect(await localDao.isBookmarked(ownerScope: accountScope, storyId: 's-acc'), isTrue);
      expect(await dal.getPendingMutations(accountScope), hasLength(1));
      expect(await db.query('offline_chapters'), hasLength(1));
    });
  });

  group('P0-M06: Live Authority Admission, Async Acquisition & Stale Generation', () {
    late _MockApiClient mockApiClient;
    late _MockTokenStorage mockTokenStorage;
    late _MockSecureStorage mockSecureStorage;
    late Map<String, String> secureStorageData;
    late InstallationIdentityProvider installProvider;
    late GuestProfileIdentityProvider guestProvider;
    late ActiveScopeCoordinator coordinator;
    late AuthService authService;
    late AuthScopeBridge bridge;

    setUp(() {
      mockApiClient = _MockApiClient();
      mockTokenStorage = _MockTokenStorage();
      mockSecureStorage = _MockSecureStorage();
      secureStorageData = <String, String>{};

      when(() => mockSecureStorage.read(key: any(named: 'key')))
          .thenAnswer((inv) async => secureStorageData[inv.namedArguments[#key] as String]);
      when(() => mockSecureStorage.write(key: any(named: 'key'), value: any(named: 'value')))
          .thenAnswer((inv) async {
        secureStorageData[inv.namedArguments[#key] as String] = inv.namedArguments[#value] as String;
      });
      when(() => mockSecureStorage.delete(key: any(named: 'key')))
          .thenAnswer((inv) async {
        secureStorageData.remove(inv.namedArguments[#key] as String);
      });

      installProvider = InstallationIdentityProvider(secureStorage: mockSecureStorage, prefs: prefs);
      guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );
      authService = AuthService(apiClient: mockApiClient, tokenStorage: mockTokenStorage);
      bridge = AuthScopeBridge(authService: authService, coordinator: coordinator)..attach();
    });

    tearDown(() {
      bridge.dispose();
    });

    Future<void> signInAndResolve(String userId) async {
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.login,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response<Map<String, dynamic>>(
            requestOptions: RequestOptions(path: ApiEndpoints.login),
            statusCode: 200,
            data: <String, dynamic>{
              'user': <String, dynamic>{
                'id': userId,
                'username': userId,
                'email': '$userId@omninovel.com',
                'role': 'READER',
              },
              'accessToken': _encodeJwt(<String, Object?>{'sub': userId, 'sid': 'sid-$userId'}),
              'refreshToken': 'refresh-$userId',
            },
          ));
      when(() => mockTokenStorage.saveTokens(
            accessToken: any(named: 'accessToken'),
            refreshToken: any(named: 'refreshToken'),
          )).thenAnswer((_) async {});

      await authService.login(identifier: userId, password: 'pw');
      await bridge.settle();
      await coordinator.resolveToAccount(
        userId,
        expectedGeneration: coordinator.transitionGeneration,
      );
    }

    test('enforces live AuthService + ActiveScopeCoordinator transitions, pendingVerification, cross-user & stale generation locks', () async {
      // 1. Bootstrapping / guest / transitioning cannot capture AccountWriteAdmission
      expect(
        () => AccountWriteAdmission.captureFromLive(coordinator: coordinator, authService: authService),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );

      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);
      await authService.initializeAuth();
      await bridge.settle();
      expect(coordinator.state, ActiveScopeState.guest);

      expect(
        () => AccountWriteAdmission.captureFromLive(coordinator: coordinator, authService: authService),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );

      // 2. Sign in user-A, hold transitioning before resolve -> admission MUST still reject
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.login,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response<Map<String, dynamic>>(
            requestOptions: RequestOptions(path: ApiEndpoints.login),
            statusCode: 200,
            data: <String, dynamic>{
              'user': <String, dynamic>{
                'id': 'user-A',
                'username': 'userA',
                'email': 'a@omninovel.com',
                'role': 'READER',
              },
              'accessToken': _encodeJwt(<String, Object?>{'sub': 'user-A', 'sid': 'sid-A'}),
              'refreshToken': 'refresh-A',
            },
          ));
      when(() => mockTokenStorage.saveTokens(
            accessToken: any(named: 'accessToken'),
            refreshToken: any(named: 'refreshToken'),
          )).thenAnswer((_) async {});

      await authService.login(identifier: 'user-A', password: 'pw');
      await bridge.settle();
      expect(coordinator.state, ActiveScopeState.transitioning);

      final prematureGen = coordinator.transitionGeneration;
      final prematureAdmission = AccountWriteAdmission.forLiveSession(
        coordinator: coordinator,
        authService: authService,
        expectedUserId: 'user-A',
        expectedGeneration: prematureGen,
      );
      await expectLater(
        () => dal.putSyncMeta(
          const SyncMeta(ownerScope: 'account:user-A', lastSyncTimestamp: '2026-01-01T00:00:00.000Z'),
          admission: prematureAdmission,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );

      // 3. Resolve to user-A -> capture works & writes succeed
      await coordinator.resolveToAccount('user-A', expectedGeneration: prematureGen);
      final liveAdmA1 = AccountWriteAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
      );
      await dal.putSyncMeta(
        const SyncMeta(
          ownerScope: 'account:user-A',
          lastSyncedServerRevision: '10',
          lastSyncTimestamp: '2026-01-01T00:00:00.000Z',
        ),
        admission: liveAdmA1,
      );

      // Cross-account target with user-A admission -> rejected
      await expectLater(
        () => dal.putSyncMeta(
          const SyncMeta(
            ownerScope: 'account:user-B',
            lastSyncTimestamp: '2026-01-01T00:00:00.000Z',
          ),
          admission: liveAdmA1,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );

      // 4. Synchronous auth revocation (even BEFORE AuthScopeBridge settles!) immediately rejects Barrier 1
      when(() => mockTokenStorage.clearTokens()).thenAnswer((_) async {});
      authService.handleSessionExpired();
      await expectLater(
        () => dal.putSyncMeta(
          const SyncMeta(
            ownerScope: 'account:user-A',
            lastSyncedServerRevision: '11',
            lastSyncTimestamp: '2026-01-01T00:01:00.000Z',
          ),
          admission: liveAdmA1,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );
      await bridge.settle();

      // 5. PendingVerification offline hint user MUST NOT pass AccountWriteAdmission
      authService.updateStateForTesting(
        AuthState.pendingVerification(
          hintUser: authService.state.user,
          accessToken: 'stale-token',
          message: 'offline',
        ),
      );
      await bridge.settle();
      await expectLater(
        () => dal.putSyncMeta(
          const SyncMeta(
            ownerScope: 'account:user-A',
            lastSyncedServerRevision: '11',
            lastSyncTimestamp: '2026-01-01T00:02:00.000Z',
          ),
          admission: liveAdmA1,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );

      // 6. Re-login as user-A yields NEW generation -> old capability liveAdmA1 MUST remain permanently stale!
      await signInAndResolve('user-A');
      await expectLater(
        () => dal.putSyncMeta(
          const SyncMeta(
            ownerScope: 'account:user-A',
            lastSyncedServerRevision: '12',
            lastSyncTimestamp: '2026-01-01T00:03:00.000Z',
          ),
          admission: liveAdmA1,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );
      // Fresh capability succeeds
      final liveAdmA2 = AccountWriteAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
      );
      await dal.putSyncMeta(
        const SyncMeta(
          ownerScope: 'account:user-A',
          lastSyncedServerRevision: '12',
          lastSyncTimestamp: '2026-01-01T00:03:00.000Z',
        ),
        admission: liveAdmA2,
      );
      expect((await dal.getSyncMeta('account:user-A'))?.lastSyncedServerRevision, '12');

      // 7. Logout & switch to user-B invalidates liveAdmA2
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);
      await authService.logout();
      await bridge.settle();
      await signInAndResolve('user-B');
      await expectLater(
        () => dal.putSyncMeta(
          const SyncMeta(
            ownerScope: 'account:user-A',
            lastSyncedServerRevision: '13',
            lastSyncTimestamp: '2026-01-01T00:04:00.000Z',
          ),
          admission: liveAdmA2,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );
    });

    test('Barrier 2 aborts AFTER async DB acquisition delay before opening transaction, and Barrier 4 seals pre-commit rollback', () async {
      await signInAndResolve('user-async');
      final admission = AccountWriteAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
      );

      final dbCompleter = Completer<Database>();
      final spyDb = _TransactionSpyDatabase(offlineDb.database);
      final asyncDal = SyncStorageDal(asyncDatabaseProvider: () => dbCompleter.future);

      when(() => mockTokenStorage.clearTokens()).thenAnswer((_) async {});

      final writeFuture = asyncDal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: 'account:user-async',
          mutationId: 'mut-barrier-2',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 's-1',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 's-1'},
        ),
        admission: admission,
      );

      // Expire session while awaiting DB handle acquisition (between Barrier 1 & Barrier 2)
      authService.handleSessionExpired();
      dbCompleter.complete(spyDb);

      await expectLater(writeFuture, throwsA(isA<SyncAdmissionRejectedError>()));
      // Barrier 2 MUST abort BEFORE db.transaction() is ever called!
      expect(spyDb.transactionCalls, 0);
      expect(await dal.getPendingMutations('account:user-async'), isEmpty);
      await bridge.settle();

      // Barrier 4 test with live logout inside onBeforeCommitHook
      await signInAndResolve('user-async');
      final admission2 = AccountWriteAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
      );
      await expectLater(
        () => dal.enqueuePendingMutation(
          PendingMutationRecord.create(
            ownerScope: 'account:user-async',
            mutationId: 'mut-barrier-4',
            clientId: kTestClientId,
            domain: SyncDomain.bookmark,
            entityId: 's-1',
            operation: SyncOperation.upsert,
            baseServerRevision: '0',
            payload: const <String, Object?>{'storyId': 's-1'},
          ),
          admission: admission2,
          onBeforeCommitHook: (_) async {
            authService.handleSessionExpired();
          },
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );
      expect(await dal.getPendingMutations('account:user-async'), isEmpty);
      expect(
        await offlineDb.database.query(
          'sync_mutation_sequences',
          where: 'owner_scope = ?',
          whereArgs: <Object?>['account:user-async'],
        ),
        isEmpty,
      );
    });
  });

  group('P1-M07: Reading Mode Fail-Closed', () {
    test('normalizes canonical modes and throws InvalidSyncReadingModeException on null, empty, or unknown values everywhere', () async {
      expect(normalizeSyncReadingMode('WEBTOON'), 'WEBTOON');
      expect(normalizeSyncReadingMode('PAGED'), 'PAGED');
      expect(normalizeSyncReadingMode('NOVEL'), 'NOVEL');
      expect(normalizeSyncReadingMode('MANGA_PAGED'), 'PAGED');
      expect(normalizeSyncReadingMode(' manga_paged '), 'PAGED');

      for (final bad in <String?>[null, '', '   ', 'UNKNOWN', 'SCROLL', 'PAGED_MANGA', 'AUDIO']) {
        expect(
          () => normalizeSyncReadingMode(bad),
          throwsA(isA<InvalidSyncReadingModeException>()),
          reason: 'Expected fail-closed rejection for readingMode=$bad',
        );
      }

      const scope = 'account:reading-mode';
      final admission = testAccountAdmission(scope);
      final now = DateTime.utc(2026, 2, 1);

      // buildSyncProgressPayload fail-closed
      final invalidProgress = LocalReadingProgress(
        ownerScope: scope,
        storyId: 's-1',
        chapterId: 'c-1',
        readingMode: 'INVALID_SCROLL',
        progressPercentage: 50,
        scrollPosition: 0,
        updatedAt: now,
        deviceTimestamp: now,
      );
      expect(
        () => buildSyncProgressPayload(invalidProgress),
        throwsA(isA<InvalidSyncReadingModeException>()),
      );

      // recordReadingSessionWithMutation rejects invalid LocalReadingProgress.readingMode
      await expectLater(
        () => dal.recordReadingSessionWithMutation(
          progress: invalidProgress,
          history: LocalReadingHistory(
            ownerScope: scope,
            storyId: 's-1',
            chapterId: 'c-1',
            storyTitle: 'Title',
            chapterNumber: '1',
            progressPercentage: 50,
            lastReadAt: now,
          ),
          mutation: PendingMutationRecord.create(
            ownerScope: scope,
            mutationId: 'mut-bad-mode-1',
            clientId: kTestClientId,
            domain: SyncDomain.progress,
            entityId: 's-1',
            operation: SyncOperation.upsert,
            baseServerRevision: '0',
            payload: const <String, Object?>{'readingMode': 'WEBTOON'},
            createdAt: now,
          ),
          admission: admission,
        ),
        throwsA(isA<InvalidSyncReadingModeException>()),
      );

      // enqueuePendingMutation rejects invalid readingMode inside PROGRESS payload (including null/empty/unknown)
      for (final badPayloadMode in <Object?>[null, '', 'SCROLL', 123]) {
        await expectLater(
          () => dal.enqueuePendingMutation(
            PendingMutationRecord.create(
              ownerScope: scope,
              mutationId: 'mut-bad-payload-${badPayloadMode ?? "null"}',
              clientId: kTestClientId,
              domain: SyncDomain.progress,
              entityId: 's-1',
              operation: SyncOperation.upsert,
              baseServerRevision: '0',
              payload: <String, Object?>{'storyId': 's-1', 'readingMode': badPayloadMode},
              createdAt: now,
            ),
            admission: admission,
          ),
          throwsA(isA<InvalidSyncReadingModeException>()),
        );
      }

      // applyAuthoritativeDeltaPage rejects PROGRESS item carrying invalid readingMode
      await expectLater(
        () => dal.applyAuthoritativeDeltaPage(
          ownerScope: scope,
          expectedCheckpoint: '0',
          admission: admission,
          page: SyncChangesPage(
            currentServerRevision: '5',
            minActiveRevision: '0',
            nextRevision: null,
            hasMore: false,
            changes: <SyncChangeItem>[
              SyncChangeItem.typed(
                revision: '5',
                domain: SyncDomain.progress,
                entityId: 's-1',
                operation: SyncOperation.upsert,
                payload: const <String, Object?>{'storyId': 's-1', 'readingMode': 'UNKNOWN_MODE'},
              ),
            ],
          ),
        ),
        throwsA(isA<InvalidSyncReadingModeException>()),
      );

      // stageSnapshotItems rejects PROGRESS item carrying invalid readingMode
      await expectLater(
        () => dal.stageSnapshotItems(
          ownerScope: scope,
          admission: admission,
          items: <SnapshotStagingItem>[
            SnapshotStagingItem(
              ownerScope: scope,
              sessionId: 'sess-bad-mode',
              snapshotRevision: '5',
              minActiveRevision: '0',
              domain: SyncDomain.progress,
              entityKey: 's-1',
              payload: const <String, Object?>{'storyId': 's-1', 'readingMode': ''},
              stagedAtIso: now.toIso8601String(),
              stagedAtMs: now.millisecondsSinceEpoch,
            ),
          ],
        ),
        throwsA(isA<InvalidSyncReadingModeException>()),
      );

      expect(await dal.getPendingMutations(scope), isEmpty);
      expect(await dal.getSyncMeta(scope), isNull);
    });
  });

  group('P1-M08: Durable ClientId Identity & Separation', () {
    test('SyncClientIdentityProvider reuses InstallationIdentityProvider, survives restarts/logouts/clearPreferences, and rejects identity collisions', () async {
      final secureMap = <String, String>{};
      final mockSecure = _MockSecureStorage();
      when(() => mockSecure.read(key: any(named: 'key')))
          .thenAnswer((inv) async => secureMap[inv.namedArguments[#key] as String]);
      when(() => mockSecure.write(key: any(named: 'key'), value: any(named: 'value')))
          .thenAnswer((inv) async {
        secureMap[inv.namedArguments[#key] as String] = inv.namedArguments[#value] as String;
      });

      final install1 = InstallationIdentityProvider(secureStorage: mockSecure, prefs: prefs);
      final clientIdProvider1 = SyncClientIdentityProvider(installationProvider: install1);

      final jwtWithDistinctSid = _encodeJwt(<String, Object?>{
        'sub': '33333333-3333-4333-8333-333333333333',
        'sid': '44444444-4444-4444-8444-444444444444',
      });

      final clientId1 = await clientIdProvider1.getOrCreateClientId(
        currentUserId: '33333333-3333-4333-8333-333333333333',
        currentGuestProfileId: '55555555-5555-4555-8555-555555555555',
        accessToken: jwtWithDistinctSid,
      );

      expect(isValidUuidV4(clientId1), isTrue);
      // Verify SSoT reuse of InstallationIdentityProvider
      expect(clientId1, (await install1.getOrCreateInstallationId()).toLowerCase());
      // Verify sync_meta schema did NOT add redundant client_id column
      final tableInfo = await offlineDb.database.rawQuery('PRAGMA table_info(sync_meta);');
      final columnNames = tableInfo.map((r) => r['name'] as String).toList();
      expect(columnNames, isNot(contains('client_id')));

      // Survives ActiveScopeCoordinator.onLogout(), PreferencesService.clearPreferences(), DB reopen, and fresh provider instances
      final coordinator = ActiveScopeCoordinator(
        installProvider: install1,
        guestProfileProvider: GuestProfileIdentityProvider(prefs: prefs),
      );
      await coordinator.onLogout();
      await PreferencesService(prefs).clearPreferences();
      await offlineDb.close();
      offlineDb = OfflineDatabase();
      await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
        singleInstance: false,
      );

      final install2 = InstallationIdentityProvider(secureStorage: mockSecure, prefs: prefs);
      final clientIdProvider2 = SyncClientIdentityProvider(installationProvider: install2);
      final clientId2 = await clientIdProvider2.getOrCreateClientId(
        currentUserId: '66666666-6666-4666-8666-666666666666',
      );
      expect(clientId2, clientId1);

      // Collision guards: userId, guestProfileId, explicit jwtSessionId, and JWT sid claim
      await expectLater(
        () => clientIdProvider2.getOrCreateClientId(currentUserId: clientId1),
        throwsA(isA<InvalidClientIdentityException>()),
      );
      await expectLater(
        () => clientIdProvider2.getOrCreateClientId(currentGuestProfileId: clientId1),
        throwsA(isA<InvalidClientIdentityException>()),
      );
      await expectLater(
        () => clientIdProvider2.getOrCreateClientId(jwtSessionId: clientId1),
        throwsA(isA<InvalidClientIdentityException>()),
      );
      final collidingJwt = _encodeJwt(<String, Object?>{'sub': 'user-other', 'sid': clientId1});
      await expectLater(
        () => clientIdProvider2.getOrCreateClientId(accessToken: collidingJwt),
        throwsA(isA<InvalidClientIdentityException>()),
      );

      // Non-UUIDv4 installation id fails closed
      secureMap[InstallationIdentityProvider.keyInstallationId] = 'not-a-uuid-v4';
      await prefs.setString(InstallationIdentityProvider.keyInstallationId, 'not-a-uuid-v4');
      final badProvider = SyncClientIdentityProvider(
        installationProvider: InstallationIdentityProvider(secureStorage: mockSecure, prefs: prefs),
      );
      await expectLater(
        () => badProvider.getOrCreateClientId(),
        throwsA(isA<InvalidClientIdentityException>()),
      );
    });

    test('SyncStorageDal rejects non-UUIDv4 or userId-collided clientId on pending and quarantined mutations', () async {
      const userId = '11111111-1111-4111-8111-111111111111';
      const scope = 'account:$userId';
      final admission = testAccountAdmission(scope);
      final now = DateTime.utc(2026, 2, 1);

      final invalidClientIds = <String>[
        '',
        'cli-1',
        '11111111-1111-1111-8111-111111111111', // version 1 instead of 4
        '11111111-1111-4111-0111-111111111111', // variant 0 instead of 8/9/a/b
        ' $kTestClientIdAlt ',
        userId, // matches account userId!
      ];

      for (final badClientId in invalidClientIds) {
        await expectLater(
          () => dal.enqueuePendingMutation(
            PendingMutationRecord.create(
              ownerScope: scope,
              mutationId: 'mut-bad-${badClientId.hashCode}',
              clientId: badClientId,
              domain: SyncDomain.bookmark,
              entityId: 's-1',
              operation: SyncOperation.upsert,
              baseServerRevision: '0',
              payload: const <String, Object?>{'storyId': 's-1'},
              createdAt: now,
            ),
            admission: admission,
          ),
          throwsA(isA<InvalidClientIdentityException>()),
          reason: 'Pending mutation should reject clientId="$badClientId"',
        );

        await expectLater(
          () => dal.quarantineMutation(
            QuarantinedMutationRecord(
              ownerScope: scope,
              mutationId: 'q-bad-${badClientId.hashCode}',
              clientId: badClientId,
              domain: SyncDomain.bookmark,
              entityId: 's-1',
              operation: SyncOperation.upsert,
              baseServerRevision: '0',
              payload: const <String, Object?>{'storyId': 's-1'},
              originalCreatedAtIso: now.toIso8601String(),
              originalCreatedAtMs: now.millisecondsSinceEpoch,
              rejectionReason: 'manual',
              rejectedAtIso: now.toIso8601String(),
              rejectedAtMs: now.millisecondsSinceEpoch,
            ),
            admission: admission,
          ),
          throwsA(isA<InvalidClientIdentityException>()),
          reason: 'Quarantine should reject clientId="$badClientId"',
        );
      }

      // Distinct valid UUIDv4 succeeds
      final saved = await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: scope,
          mutationId: 'mut-valid-uuid',
          clientId: kTestClientIdAlt,
          domain: SyncDomain.bookmark,
          entityId: 's-1',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 's-1'},
          createdAt: now,
        ),
        admission: admission,
      );
      expect(saved.clientId, kTestClientIdAlt);
    });
  });
}

class _TransactionSpyDatabase extends Fake implements Database {
  final Database _inner;
  int transactionCalls = 0;

  _TransactionSpyDatabase(this._inner);

  @override
  Future<T> transaction<T>(
    Future<T> Function(Transaction txn) action, {
    bool? exclusive,
  }) {
    transactionCalls++;
    return _inner.transaction<T>(action, exclusive: exclusive);
  }
}
