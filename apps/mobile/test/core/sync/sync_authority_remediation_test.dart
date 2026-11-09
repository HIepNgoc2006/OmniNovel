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
  SyncAuthoritySnapshot readAuthoritySnapshot() {
    return SyncAuthoritySnapshot(
      scopeState: ActiveScopeState.guest,
      activeScope: authorizedScope,
      canMutateUserState: true,
      transitionGeneration: expectedGeneration,
      isAuthenticated: false,
      authenticatedUserId: null,
    );
  }

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

    test('P0-M05 RACE: purgeGuestLocalScope throws PurgeProhibitedError & rolls back 100% if quarantined inside onBeforeCommitHook', () async {
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      const guestId = 'g-race-hook';
      const guestScope = 'guest:$guestId';
      final t = DateTime.utc(2026, 2, 1);

      await localDao.saveBookmark(
        LocalBookmark(ownerScope: guestScope, storyId: 's-hook', title: 'Hook', createdAt: t),
      );
      await localDao.saveProgress(
        LocalReadingProgress(
          ownerScope: guestScope,
          storyId: 's-hook',
          chapterId: 'c-hook',
          readingMode: 'WEBTOON',
          progressPercentage: 55.0,
          scrollPosition: 10.0,
          updatedAt: t,
          deviceTimestamp: t,
        ),
      );
      await localDao.saveHistory(
        LocalReadingHistory(
          ownerScope: guestScope,
          storyId: 's-hook',
          chapterId: 'c-hook',
          storyTitle: 'Hook Story',
          chapterNumber: '1',
          progressPercentage: 55.0,
          lastReadAt: t,
        ),
      );
      await dal.putGuestLocalPreference(
        LocalPreferenceRecord(
          ownerScope: guestScope,
          prefKey: 'theme',
          value: 'dark',
          updatedAt: t.toIso8601String(),
        ),
        admission: testGuestAdmission(guestScope),
      );

      await expectLater(
        () => dal.purgeGuestLocalScope(
          guestScope: guestScope,
          reason: GuestLifecyclePurgeReason.userClearedGuestData,
          admission: testGuestAdmission(guestScope),
          guestProfileProvider: guestProvider,
          onBeforeCommitHook: (_) async {
            await guestProvider.quarantineGuestScope(guestId);
          },
        ),
        throwsA(isA<PurgeProhibitedError>()),
      );

      // SQLite rollback MUST preserve ALL 4 guest-local tables!
      expect(await localDao.isBookmarked(ownerScope: guestScope, storyId: 's-hook'), isTrue);
      expect((await localDao.getProgress(ownerScope: guestScope, storyId: 's-hook'))?.chapterId, 'c-hook');
      expect((await localDao.getHistoryItem(ownerScope: guestScope, storyId: 's-hook', chapterId: 'c-hook'))?.progressPercentage, 55.0);
      expect((await dal.getGuestLocalPreference(guestScope, 'theme'))?.value, 'dark');
    });

    test('P0-M05 RACE: purgeGuestLocalScope rolls back 100% if quarantine OR claim journal insert occurs between async txn.delete calls', () async {
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      const guestId = 'g-race-between-deletes';
      const guestScope = 'guest:$guestId';
      final t = DateTime.utc(2026, 2, 1);

      await localDao.saveBookmark(
        LocalBookmark(ownerScope: guestScope, storyId: 's-mid', title: 'Mid', createdAt: t),
      );
      await localDao.saveProgress(
        LocalReadingProgress(
          ownerScope: guestScope,
          storyId: 's-mid',
          chapterId: 'c-mid',
          readingMode: 'NOVEL',
          progressPercentage: 70.0,
          scrollPosition: 0.0,
          updatedAt: t,
          deviceTimestamp: t,
        ),
      );
      await localDao.saveHistory(
        LocalReadingHistory(
          ownerScope: guestScope,
          storyId: 's-mid',
          chapterId: 'c-mid',
          storyTitle: 'Mid Story',
          chapterNumber: '2',
          progressPercentage: 70.0,
          lastReadAt: t,
        ),
      );
      await dal.putGuestLocalPreference(
        LocalPreferenceRecord(
          ownerScope: guestScope,
          prefKey: 'font_size',
          value: 18,
          updatedAt: t.toIso8601String(),
        ),
        admission: testGuestAdmission(guestScope),
      );

      final interleavingDb = _InterleavingDeleteDatabase(
        offlineDb.database,
        triggerAfterDeleteCount: 2,
        onDeleteThresholdReached: () async {
          await guestProvider.quarantineGuestScope(guestId);
        },
      );
      final racingDal = SyncStorageDal(customDb: interleavingDb);

      await expectLater(
        () => racingDal.purgeGuestLocalScope(
          guestScope: guestScope,
          reason: GuestLifecyclePurgeReason.userClearedGuestData,
          admission: testGuestAdmission(guestScope),
          guestProfileProvider: guestProvider,
        ),
        throwsA(isA<PurgeProhibitedError>()),
      );

      // Even tables 1 & 2 (deleted BEFORE delete #2 threshold) MUST be rolled back cleanly!
      expect(await localDao.isBookmarked(ownerScope: guestScope, storyId: 's-mid'), isTrue);
      expect((await localDao.getProgress(ownerScope: guestScope, storyId: 's-mid'))?.chapterId, 'c-mid');
      expect((await localDao.getHistoryItem(ownerScope: guestScope, storyId: 's-mid', chapterId: 'c-mid'))?.progressPercentage, 70.0);
      expect((await dal.getGuestLocalPreference(guestScope, 'font_size'))?.value, 18);

      // Also verify recovery journal insert inside onBeforeCommitHook causes rollback with PurgeProhibitedError
      const journalRaceId = 'g-race-journal-hook';
      const journalRaceScope = 'guest:$journalRaceId';
      await localDao.saveBookmark(
        LocalBookmark(ownerScope: journalRaceScope, storyId: 's-j', title: 'J', createdAt: t),
      );
      await expectLater(
        () => dal.purgeGuestLocalScope(
          guestScope: journalRaceScope,
          reason: GuestLifecyclePurgeReason.userClearedGuestData,
          admission: testGuestAdmission(journalRaceScope),
          guestProfileProvider: guestProvider,
          onBeforeCommitHook: (txn) async {
            await txn.insert('guest_claim_recovery_journal', <String, Object?>{
              'claim_id': 'claim-race-mid-purge',
              'user_id': 'u-race',
              'guest_profile_id': journalRaceId,
              'expected_state_fingerprint': 'fp',
              'conflict_decisions': '{}',
              'phase': 'prepared',
              'created_at': 1000,
              'updated_at': 1000,
            });
          },
        ),
        throwsA(isA<PurgeProhibitedError>()),
      );
      expect(await localDao.isBookmarked(ownerScope: journalRaceScope, storyId: 's-j'), isTrue);
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

    test('SyncStorageDal.bound enforces durable clientId authority, rejects per-mutation random/spoofed UUIDs & live JWT sid collisions', () async {
      final secureMap = <String, String>{};
      final mockSecure = _MockSecureStorage();
      final mockApiClient = _MockApiClient();
      final mockTokenStorage = _MockTokenStorage();

      when(() => mockSecure.read(key: any(named: 'key')))
          .thenAnswer((inv) async => secureMap[inv.namedArguments[#key] as String]);
      when(() => mockSecure.write(key: any(named: 'key'), value: any(named: 'value')))
          .thenAnswer((inv) async {
        secureMap[inv.namedArguments[#key] as String] = inv.namedArguments[#value] as String;
      });
      when(() => mockSecure.delete(key: any(named: 'key')))
          .thenAnswer((inv) async {
        secureMap.remove(inv.namedArguments[#key] as String);
      });
      when(() => mockTokenStorage.saveTokens(
            accessToken: any(named: 'accessToken'),
            refreshToken: any(named: 'refreshToken'),
          )).thenAnswer((_) async {});
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.clearTokens()).thenAnswer((_) async {});

      final installProvider = InstallationIdentityProvider(secureStorage: mockSecure, prefs: prefs);
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      final clientIdProvider = SyncClientIdentityProvider(installationProvider: installProvider);
      final coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );
      final authService = AuthService(apiClient: mockApiClient, tokenStorage: mockTokenStorage);
      final bridge = AuthScopeBridge(authService: authService, coordinator: coordinator)..attach();

      addTearDown(bridge.dispose);

      final boundDal = SyncStorageDal.bound(
        offlineDatabase: offlineDb,
        clientIdentityProvider: clientIdProvider,
        guestProfileProvider: guestProvider,
      );
      expect(boundDal.hasBoundClientIdentity, isTrue);

      Future<void> signInAndResolve(String userId, {String? customSid}) async {
        final sid = customSid ?? 'sid-$userId';
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
                'accessToken': _encodeJwt(<String, Object?>{'sub': userId, 'sid': sid}),
                'refreshToken': 'refresh-$userId',
              },
            ));
        await authService.login(identifier: userId, password: 'pw');
        await bridge.settle();
        await coordinator.resolveToAccount(
          userId,
          expectedGeneration: coordinator.transitionGeneration,
        );
      }

      await signInAndResolve('user-bound-A');
      final admA = AccountWriteAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
      );
      final durableClientId = await clientIdProvider.getOrCreateClientId(
        currentUserId: 'user-bound-A',
        accessToken: authService.state.accessToken,
      );
      final now = DateTime.utc(2026, 2, 1);

      // Consecutive mutations reuse exact same durable clientId
      final p1 = await boundDal.putBookmarkWithMutation(
        bookmark: LocalBookmark(ownerScope: 'account:user-bound-A', storyId: 's-1', title: 'S1', createdAt: now),
        mutation: PendingMutationRecord.create(
          ownerScope: 'account:user-bound-A',
          mutationId: 'mut-bound-1',
          clientId: durableClientId,
          domain: SyncDomain.bookmark,
          entityId: 's-1',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 's-1'},
          createdAt: now,
        ),
        admission: admA,
      );
      final progress = LocalReadingProgress(
        ownerScope: 'account:user-bound-A',
        storyId: 's-1',
        chapterId: 'c-1',
        readingMode: 'WEBTOON',
        progressPercentage: 45,
        scrollPosition: 100,
        updatedAt: now,
        deviceTimestamp: now,
      );
      final p2 = await boundDal.recordReadingSessionWithMutation(
        progress: progress,
        history: LocalReadingHistory(
          ownerScope: 'account:user-bound-A',
          storyId: 's-1',
          chapterId: 'c-1',
          storyTitle: 'S1',
          chapterNumber: '1',
          progressPercentage: 45,
          lastReadAt: now,
        ),
        mutation: PendingMutationRecord.create(
          ownerScope: 'account:user-bound-A',
          mutationId: 'mut-bound-2',
          clientId: durableClientId,
          domain: SyncDomain.progress,
          entityId: 's-1',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: buildSyncProgressPayload(progress),
          createdAt: now,
        ),
        admission: admA,
      );
      expect(p1.clientId, durableClientId);
      expect(p2.clientId, durableClientId);

      // Account switch user-A -> user-B reuses exact same durableClientId
      await authService.logout();
      await bridge.settle();
      await signInAndResolve('user-bound-B');
      final admB = AccountWriteAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
      );
      final p3 = await boundDal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: 'account:user-bound-B',
          mutationId: 'mut-bound-3',
          clientId: durableClientId,
          domain: SyncDomain.preference,
          entityId: 'theme',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'key': 'theme', 'value': 'dark'},
          createdAt: now,
        ),
        admission: admB,
      );
      expect(p3.clientId, durableClientId);

      // Reject freshly generated per-mutation random UUIDv4 and spoofed kTestClientIdAlt
      final randomPerMutationUuid = generateUUIDv4();
      expect(randomPerMutationUuid.toLowerCase(), isNot(durableClientId));
      for (final spoofedClientId in <String>[randomPerMutationUuid, kTestClientIdAlt]) {
        await expectLater(
          () => boundDal.enqueuePendingMutation(
            PendingMutationRecord.create(
              ownerScope: 'account:user-bound-B',
              mutationId: 'mut-spoof-enq-${spoofedClientId.hashCode}',
              clientId: spoofedClientId,
              domain: SyncDomain.bookmark,
              entityId: 's-spoof',
              operation: SyncOperation.upsert,
              baseServerRevision: '0',
              payload: const <String, Object?>{'storyId': 's-spoof'},
              createdAt: now,
            ),
            admission: admB,
          ),
          throwsA(isA<InvalidClientIdentityException>()),
        );

        await expectLater(
          () => boundDal.putBookmarkWithMutation(
            bookmark: LocalBookmark(ownerScope: 'account:user-bound-B', storyId: 's-spoof', title: 'Spoof', createdAt: now),
            mutation: PendingMutationRecord.create(
              ownerScope: 'account:user-bound-B',
              mutationId: 'mut-spoof-bm-${spoofedClientId.hashCode}',
              clientId: spoofedClientId,
              domain: SyncDomain.bookmark,
              entityId: 's-spoof',
              operation: SyncOperation.upsert,
              baseServerRevision: '0',
              payload: const <String, Object?>{'storyId': 's-spoof'},
              createdAt: now,
            ),
            admission: admB,
          ),
          throwsA(isA<InvalidClientIdentityException>()),
        );

        await expectLater(
          () => boundDal.recordReadingSessionWithMutation(
            progress: LocalReadingProgress(
              ownerScope: 'account:user-bound-B',
              storyId: 's-spoof',
              chapterId: 'c-1',
              readingMode: 'NOVEL',
              progressPercentage: 10,
              scrollPosition: 0,
              updatedAt: now,
              deviceTimestamp: now,
            ),
            history: LocalReadingHistory(
              ownerScope: 'account:user-bound-B',
              storyId: 's-spoof',
              chapterId: 'c-1',
              storyTitle: 'Spoof',
              chapterNumber: '1',
              progressPercentage: 10,
              lastReadAt: now,
            ),
            mutation: PendingMutationRecord.create(
              ownerScope: 'account:user-bound-B',
              mutationId: 'mut-spoof-prog-${spoofedClientId.hashCode}',
              clientId: spoofedClientId,
              domain: SyncDomain.progress,
              entityId: 's-spoof',
              operation: SyncOperation.upsert,
              baseServerRevision: '0',
              payload: const <String, Object?>{'storyId': 's-spoof', 'readingMode': 'NOVEL'},
              createdAt: now,
            ),
            admission: admB,
          ),
          throwsA(isA<InvalidClientIdentityException>()),
        );

        await expectLater(
          () => boundDal.deleteBookmarkWithMutation(
            ownerScope: 'account:user-bound-B',
            storyId: 's-spoof',
            mutation: PendingMutationRecord.create(
              ownerScope: 'account:user-bound-B',
              mutationId: 'mut-spoof-delbm-${spoofedClientId.hashCode}',
              clientId: spoofedClientId,
              domain: SyncDomain.bookmark,
              entityId: 's-spoof',
              operation: SyncOperation.delete,
              baseServerRevision: '0',
              payload: const <String, Object?>{'storyId': 's-spoof'},
              createdAt: now,
            ),
            admission: admB,
          ),
          throwsA(isA<InvalidClientIdentityException>()),
        );

        await expectLater(
          () => boundDal.putPreferenceWithMutation(
            preference: LocalPreferenceRecord(
              ownerScope: 'account:user-bound-B',
              prefKey: 'spoof_pref',
              value: 'dark',
              updatedAt: now.toIso8601String(),
            ),
            mutation: PendingMutationRecord.create(
              ownerScope: 'account:user-bound-B',
              mutationId: 'mut-spoof-pref-${spoofedClientId.hashCode}',
              clientId: spoofedClientId,
              domain: SyncDomain.preference,
              entityId: 'spoof_pref',
              operation: SyncOperation.upsert,
              baseServerRevision: '0',
              payload: const <String, Object?>{'key': 'spoof_pref', 'value': 'dark'},
              createdAt: now,
            ),
            admission: admB,
          ),
          throwsA(isA<InvalidClientIdentityException>()),
        );

        await expectLater(
          () => boundDal.deleteStoryHistoryWithMutation(
            ownerScope: 'account:user-bound-B',
            storyId: 's-spoof',
            mutation: PendingMutationRecord.create(
              ownerScope: 'account:user-bound-B',
              mutationId: 'mut-spoof-delhist-${spoofedClientId.hashCode}',
              clientId: spoofedClientId,
              domain: SyncDomain.history,
              entityId: 's-spoof',
              operation: SyncOperation.delete,
              baseServerRevision: '0',
              payload: const <String, Object?>{'storyId': 's-spoof'},
              createdAt: now,
            ),
            admission: admB,
          ),
          throwsA(isA<InvalidClientIdentityException>()),
        );

        await expectLater(
          () => boundDal.clearAllHistoryWithMutation(
            ownerScope: 'account:user-bound-B',
            mutation: PendingMutationRecord.create(
              ownerScope: 'account:user-bound-B',
              mutationId: 'mut-spoof-clrhist-${spoofedClientId.hashCode}',
              clientId: spoofedClientId,
              domain: SyncDomain.history,
              entityId: kGlobalHistorySentinelUuid,
              operation: SyncOperation.delete,
              baseServerRevision: '0',
              payload: const <String, Object?>{},
              createdAt: now,
            ),
            admission: admB,
          ),
          throwsA(isA<InvalidClientIdentityException>()),
        );

        await expectLater(
          () => boundDal.quarantineMutation(
            QuarantinedMutationRecord(
              ownerScope: 'account:user-bound-B',
              mutationId: 'q-spoof-${spoofedClientId.hashCode}',
              clientId: spoofedClientId,
              domain: SyncDomain.bookmark,
              entityId: 's-spoof',
              operation: SyncOperation.upsert,
              baseServerRevision: '0',
              payload: const <String, Object?>{'storyId': 's-spoof'},
              originalCreatedAtIso: now.toIso8601String(),
              originalCreatedAtMs: now.millisecondsSinceEpoch,
              rejectionReason: 'manual',
              rejectedAtIso: now.toIso8601String(),
              rejectedAtMs: now.millisecondsSinceEpoch,
            ),
            admission: admB,
          ),
          throwsA(isA<InvalidClientIdentityException>()),
        );
      }

      // Spoofed mutation never leaked into local_* or pending_mutations
      expect(await localDao.isBookmarked(ownerScope: 'account:user-bound-B', storyId: 's-spoof'), isFalse);
      expect(await localDao.getProgress(ownerScope: 'account:user-bound-B', storyId: 's-spoof'), isNull);
      expect((await boundDal.getPendingMutations('account:user-bound-B')).length, 1);

      // Tampering client_id inside quarantined_mutations is also caught on requeue
      await boundDal.quarantinePendingMutationByKey(
        ownerScope: 'account:user-bound-B',
        mutationId: 'mut-bound-3',
        reason: 'network timeout',
        status: 'EXCEEDED_MAX_RETRIES',
        admission: admB,
      );
      await offlineDb.database.update(
        'quarantined_mutations',
        <String, Object?>{'client_id': generateUUIDv4()},
        where: 'owner_scope = ? AND mutation_id = ?',
        whereArgs: <Object?>['account:user-bound-B', 'mut-bound-3'],
      );
      await expectLater(
        () => boundDal.requeueQuarantinedMutation(
          ownerScope: 'account:user-bound-B',
          mutationId: 'mut-bound-3',
          admission: admB,
        ),
        throwsA(isA<InvalidClientIdentityException>()),
      );
      // Rollback leaves quarantined row intact
      expect(await boundDal.getQuarantinedMutation('account:user-bound-B', 'mut-bound-3'), isNotNull);

      // Live JWT sid collision is blocked by BOTH unbound dal & boundDal via LiveSyncAuthoritySource
      await authService.logout();
      await bridge.settle();
      await signInAndResolve('user-sid-collision', customSid: durableClientId);
      final admSidCollide = AccountWriteAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
      );
      final collidingMutation = PendingMutationRecord.create(
        ownerScope: 'account:user-sid-collision',
        mutationId: 'mut-sid-collide',
        clientId: durableClientId,
        domain: SyncDomain.bookmark,
        entityId: 's-sid',
        operation: SyncOperation.upsert,
        baseServerRevision: '0',
        payload: const <String, Object?>{'storyId': 's-sid'},
        createdAt: now,
      );
      await expectLater(
        () => dal.enqueuePendingMutation(collidingMutation, admission: admSidCollide),
        throwsA(isA<InvalidClientIdentityException>()),
      );
      await expectLater(
        () => boundDal.enqueuePendingMutation(collidingMutation, admission: admSidCollide),
        throwsA(isA<InvalidClientIdentityException>()),
      );
    });
  });

  group('Purge Lifecycle Semantics & Deadlock Prevention (Task C)', () {
    test('AccountPurgeReason.fullResyncReset clears sync cache ONLY while preserving pending, quarantined, FIFO sequences, local_*, offline_*, and journal', () async {
      const targetScope = 'account:user-resync';
      const otherScope = 'account:user-other';
      const guestKeep = 'guest:g-keep-resync';
      final admTarget = testAccountAdmission(targetScope);
      final admOther = testAccountAdmission(otherScope);
      final db = offlineDb.database;
      final now = DateTime.utc(2026, 2, 1);

      await dal.putSyncMeta(
        SyncMeta(
          ownerScope: targetScope,
          lastSyncedServerRevision: '50',
          minActiveRevision: '10',
          lastSyncTimestamp: now.toIso8601String(),
          effectiveHistoryEpochs: const <String, int>{'s-1': 2},
          authoritativeBaselineStatus: AuthoritativeBaselineStatus.bootstrapping,
        ),
        admission: admTarget,
      );
      await dal.applyAuthoritativeDeltaPage(
        ownerScope: targetScope,
        expectedCheckpoint: '50',
        admission: admTarget,
        page: SyncChangesPage(
          currentServerRevision: '51',
          minActiveRevision: '10',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '51',
              domain: SyncDomain.bookmark,
              entityId: 's-1',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'storyId': 's-1'},
            ),
          ],
        ),
      );
      await dal.stageSnapshotItems(
        ownerScope: targetScope,
        admission: admTarget,
        items: <SnapshotStagingItem>[
          SnapshotStagingItem(
            ownerScope: targetScope,
            sessionId: 'sess-resync',
            snapshotRevision: '60',
            minActiveRevision: '10',
            domain: SyncDomain.bookmark,
            entityKey: 's-stage',
            payload: const <String, Object?>{'storyId': 's-stage'},
            stagedAtIso: now.toIso8601String(),
            stagedAtMs: now.millisecondsSinceEpoch,
          ),
        ],
      );

      // Local tables + Pending + Quarantined for targetScope
      await dal.putBookmarkWithMutation(
        bookmark: LocalBookmark(ownerScope: targetScope, storyId: 's-local', title: 'Local Keep', createdAt: now),
        mutation: PendingMutationRecord.create(
          ownerScope: targetScope,
          mutationId: 'mut-keep-1',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 's-local',
          operation: SyncOperation.upsert,
          baseServerRevision: '51',
          payload: const <String, Object?>{'storyId': 's-local'},
          createdAt: now,
        ),
        admission: admTarget,
      );
      await dal.putPreferenceWithMutation(
        preference: LocalPreferenceRecord(
          ownerScope: targetScope,
          prefKey: 'theme',
          value: 'dark',
          updatedAt: now.toIso8601String(),
        ),
        mutation: PendingMutationRecord.create(
          ownerScope: targetScope,
          mutationId: 'mut-q-1',
          clientId: kTestClientId,
          domain: SyncDomain.preference,
          entityId: 'theme',
          operation: SyncOperation.upsert,
          baseServerRevision: '51',
          payload: const <String, Object?>{'key': 'theme', 'value': 'dark'},
          createdAt: now,
        ),
        admission: admTarget,
      );
      await dal.quarantinePendingMutationByKey(
        ownerScope: targetScope,
        mutationId: 'mut-q-1',
        reason: 'temporary server conflict',
        status: 'EXCEEDED_MAX_RETRIES',
        admission: admTarget,
      );
      await localDao.saveProgress(
        LocalReadingProgress(
          ownerScope: targetScope,
          storyId: 's-local',
          chapterId: 'c-1',
          readingMode: 'WEBTOON',
          progressPercentage: 60,
          scrollPosition: 10,
          updatedAt: now,
          deviceTimestamp: now,
        ),
      );
      await localDao.saveHistory(
        LocalReadingHistory(
          ownerScope: targetScope,
          storyId: 's-local',
          chapterId: 'c-1',
          storyTitle: 'Local Keep',
          chapterNumber: '1',
          progressPercentage: 60,
          lastReadAt: now,
        ),
      );

      // Seed untouched data: otherScope, guestKeep, offline_chapters, guest_claim_recovery_journal
      await dal.putSyncMeta(
        SyncMeta(ownerScope: otherScope, lastSyncedServerRevision: '99', lastSyncTimestamp: now.toIso8601String()),
        admission: admOther,
      );
      await localDao.saveBookmark(
        LocalBookmark(ownerScope: guestKeep, storyId: 's-g', title: 'Guest Keep', createdAt: now),
      );
      await db.insert('offline_chapters', <String, Object?>{
        'chapter_version_id': 'cv-resync',
        'user_id': 'user-resync',
        'chapter_id': 'c-1',
        'story_id': 's-1',
        'story_title': 'Offline Keep',
        'chapter_number': '1',
        'media_format': 'WEBTOON',
        'installed_dir': '/offline/keep',
        'total_files': 1,
        'total_bytes': 10,
        'installed_at': 1000,
        'manifest_json': '{}',
      });
      await db.insert('guest_claim_recovery_journal', <String, Object?>{
        'claim_id': 'claim-resync',
        'user_id': 'user-resync',
        'guest_profile_id': 'g-claimed',
        'expected_state_fingerprint': 'fp',
        'conflict_decisions': '{}',
        'phase': 'committing',
        'created_at': 1000,
        'updated_at': 1000,
      });

      // Execute fullResyncReset
      await dal.purgeAccountScope(
        ownerScope: targetScope,
        reason: AccountPurgeReason.fullResyncReset,
        admission: admTarget,
      );

      // Sync cache cleared -> fail-closed UNINITIALIZED
      expect(await dal.getSyncMeta(targetScope), isNull);
      expect(await dal.isAuthoritativeReady(targetScope), isFalse);
      expect(await dal.getAllAuthoritativeShadows(targetScope), isEmpty);
      expect(await dal.getSnapshotStagingItems(targetScope, 'sess-resync'), isEmpty);

      // Unsynced mutations, FIFO sequence counter & local_* MUST remain intact!
      final pending = await dal.getPendingMutations(targetScope);
      expect(pending, hasLength(1));
      expect(pending.first.mutationId, 'mut-keep-1');
      expect(pending.first.sequenceNo, 1);
      expect(await dal.getQuarantinedMutations(targetScope), hasLength(1));
      expect(await localDao.isBookmarked(ownerScope: targetScope, storyId: 's-local'), isTrue);
      expect(await localDao.getProgress(ownerScope: targetScope, storyId: 's-local'), isNotNull);
      expect(await localDao.getHistoryItem(ownerScope: targetScope, storyId: 's-local', chapterId: 'c-1'), isNotNull);
      expect((await dal.getAccountLocalPreference(targetScope, 'theme'))?.value, 'dark');

      // Sequence monotonicity continues uninterrupted from sequence_no=2 -> 3
      final nextEnqueued = await dal.enqueuePendingMutation(
        PendingMutationRecord.create(
          ownerScope: targetScope,
          mutationId: 'mut-after-resync',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 's-2',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 's-2'},
          createdAt: now,
        ),
        admission: admTarget,
      );
      expect(nextEnqueued.sequenceNo, 3);

      // Other scopes, offline_chapters & recovery journal untouched
      expect((await dal.getSyncMeta(otherScope))?.lastSyncedServerRevision, '99');
      expect(await localDao.isBookmarked(ownerScope: guestKeep, storyId: 's-g'), isTrue);
      expect(await db.query('offline_chapters'), hasLength(1));
      expect(await db.query('guest_claim_recovery_journal'), hasLength(1));
    });

    test('AccountPurgeReason.signOutReset, mid-GuestClaim block, & DetachedAccountEvictionAdmission resolve cleanup deadlocks without losing offline edits', () async {
      final mockApiClient = _MockApiClient();
      final mockTokenStorage = _MockTokenStorage();
      final mockSecureStorage = _MockSecureStorage();
      final secureData = <String, String>{};

      when(() => mockSecureStorage.read(key: any(named: 'key')))
          .thenAnswer((inv) async => secureData[inv.namedArguments[#key] as String]);
      when(() => mockSecureStorage.write(key: any(named: 'key'), value: any(named: 'value')))
          .thenAnswer((inv) async {
        secureData[inv.namedArguments[#key] as String] = inv.namedArguments[#value] as String;
      });
      when(() => mockSecureStorage.delete(key: any(named: 'key')))
          .thenAnswer((inv) async {
        secureData.remove(inv.namedArguments[#key] as String);
      });
      when(() => mockTokenStorage.saveTokens(
            accessToken: any(named: 'accessToken'),
            refreshToken: any(named: 'refreshToken'),
          )).thenAnswer((_) async {});
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.clearTokens()).thenAnswer((_) async {});

      final installProvider = InstallationIdentityProvider(secureStorage: mockSecureStorage, prefs: prefs);
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );
      final authService = AuthService(apiClient: mockApiClient, tokenStorage: mockTokenStorage);
      final bridge = AuthScopeBridge(authService: authService, coordinator: coordinator)..attach();
      addTearDown(bridge.dispose);

      Future<void> triggerLoginOnly(String userId) async {
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
        await authService.login(identifier: userId, password: 'pw');
        await bridge.settle();
      }

      Future<void> signInAndResolve(String userId) async {
        await triggerLoginOnly(userId);
        await coordinator.resolveToAccount(
          userId,
          expectedGeneration: coordinator.transitionGeneration,
        );
      }

      final db = offlineDb.database;
      final now = DateTime.utc(2026, 2, 1);

      Future<void> seedAccountFull(String userId, AccountWriteAdmission adm) async {
        final scope = 'account:$userId';
        await dal.putSyncMeta(
          SyncMeta(ownerScope: scope, lastSyncedServerRevision: '12', lastSyncTimestamp: now.toIso8601String()),
          admission: adm,
        );
        await dal.putBookmarkWithMutation(
          bookmark: LocalBookmark(ownerScope: scope, storyId: 's-$userId', title: 'BM', createdAt: now),
          mutation: PendingMutationRecord.create(
            ownerScope: scope,
            mutationId: 'mut-$userId-1',
            clientId: kTestClientId,
            domain: SyncDomain.bookmark,
            entityId: 's-$userId',
            operation: SyncOperation.upsert,
            baseServerRevision: '12',
            payload: <String, Object?>{'storyId': 's-$userId'},
            createdAt: now,
          ),
          admission: adm,
        );
        await localDao.saveProgress(
          LocalReadingProgress(
            ownerScope: scope,
            storyId: 's-$userId',
            chapterId: 'c-1',
            readingMode: 'PAGED',
            progressPercentage: 80,
            scrollPosition: 0,
            updatedAt: now,
            deviceTimestamp: now,
          ),
        );
        await localDao.saveHistory(
          LocalReadingHistory(
            ownerScope: scope,
            storyId: 's-$userId',
            chapterId: 'c-1',
            storyTitle: 'Story',
            chapterNumber: '1',
            progressPercentage: 80,
            lastReadAt: now,
          ),
        );
        await dal.putPreferenceWithMutation(
          preference: LocalPreferenceRecord(
            ownerScope: scope,
            prefKey: 'theme',
            value: 'sepia',
            updatedAt: now.toIso8601String(),
          ),
          mutation: PendingMutationRecord.create(
            ownerScope: scope,
            mutationId: 'mut-$userId-2',
            clientId: kTestClientId,
            domain: SyncDomain.preference,
            entityId: 'theme',
            operation: SyncOperation.upsert,
            baseServerRevision: '12',
            payload: const <String, Object?>{'key': 'theme', 'value': 'sepia'},
            createdAt: now,
          ),
          admission: adm,
        );
        await dal.quarantinePendingMutationByKey(
          ownerScope: scope,
          mutationId: 'mut-$userId-2',
          reason: 'manual',
          admission: adm,
        );
      }

      // Preserve offline_chapters across all cleanups
      await db.insert('offline_chapters', <String, Object?>{
        'chapter_version_id': 'cv-signout-keep',
        'user_id': 'user-A',
        'chapter_id': 'c-1',
        'story_id': 's-1',
        'story_title': 'Offline Keep',
        'chapter_number': '1',
        'media_format': 'WEBTOON',
        'installed_dir': '/offline/signout',
        'total_files': 1,
        'total_bytes': 10,
        'installed_at': 1000,
        'manifest_json': '{}',
      });

      // 1. Pre-AuthService.logout(): signOutReset MUST SUCCEED
      await signInAndResolve('user-A');
      final admPreLogout = AccountWriteAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
      );
      await seedAccountFull('user-A', admPreLogout);
      await dal.purgeAccountScope(
        ownerScope: 'account:user-A',
        reason: AccountPurgeReason.signOutReset,
        admission: admPreLogout,
      );
      expect(await dal.getSyncMeta('account:user-A'), isNull);
      expect(await dal.getPendingMutations('account:user-A'), isEmpty);
      expect(await localDao.isBookmarked(ownerScope: 'account:user-A', storyId: 's-user-A'), isFalse);
      expect(await db.query('offline_chapters'), hasLength(1));

      // 2. Post-AuthService.logout() OR handleSessionExpired(): purgeAccountScope(signOutReset) MUST FAIL!
      await authService.logout();
      await bridge.settle();
      await signInAndResolve('user-C');
      final admC = AccountWriteAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
      );
      await seedAccountFull('user-C', admC);

      // Post-logout rejection
      await authService.logout();
      await bridge.settle();
      await expectLater(
        () => dal.purgeAccountScope(
          ownerScope: 'account:user-C',
          reason: AccountPurgeReason.signOutReset,
          admission: admC,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );
      expect(await dal.getPendingMutations('account:user-C'), hasLength(1));

      // Re-sign in user-C -> synchronous handleSessionExpired() rejects immediately
      await signInAndResolve('user-C');
      final admC2 = AccountWriteAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
      );
      authService.handleSessionExpired();
      await expectLater(
        () => dal.purgeAccountScope(
          ownerScope: 'account:user-C',
          reason: AccountPurgeReason.signOutReset,
          admission: admC2,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );
      await bridge.settle();

      // 3. After handleSessionExpired(), user-C has unsynced mutations -> DetachedAccountEvictionAdmission default blocks data loss!
      final detachedAdmC = DetachedAccountEvictionAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
        targetUserId: 'user-C',
      );
      await expectLater(
        () => dal.evictDetachedAccountScope(
          ownerScope: 'account:user-C',
          admission: detachedAdmC,
        ),
        throwsA(
          isA<PurgeProhibitedError>().having(
            (e) => e.message,
            'message',
            contains('UNSYNCED_MUTATIONS_PRESENT'),
          ),
        ),
      );
      // Pending & quarantined edits are 100% preserved
      expect(await dal.getPendingMutations('account:user-C'), hasLength(1));
      expect(await dal.getQuarantinedMutations('account:user-C'), hasLength(1));

      // 4. Mid-GuestClaim (ActiveScopeState.transitioning) blocks BOTH AccountWriteAdmission & DetachedAccountEvictionAdmission
      await triggerLoginOnly('user-D');
      expect(coordinator.state, ActiveScopeState.transitioning);
      await expectLater(
        () => DetachedAccountEvictionAdmission.captureFromLive(
          coordinator: coordinator,
          authService: authService,
          targetUserId: 'user-C',
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );
      await expectLater(
        () => dal.evictDetachedAccountScope(
          ownerScope: 'account:user-C',
          admission: detachedAdmC,
          discardUnsyncedMutations: true,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );

      // Resolve to user-D (simulates account switch user-C -> user-D)
      await coordinator.resolveToAccount(
        'user-D',
        expectedGeneration: coordinator.transitionGeneration,
      );
      final admD = AccountWriteAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
      );
      await seedAccountFull('user-D', admD);

      // Cannot use DetachedAccountEvictionAdmission on active user-D
      await expectLater(
        () => DetachedAccountEvictionAdmission.captureFromLive(
          coordinator: coordinator,
          authService: authService,
          targetUserId: 'user-D',
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );
      // Cross-account purgeAccountScope(user-C) using user-D admission or stale user-C admission fails!
      await expectLater(
        () => dal.purgeAccountScope(
          ownerScope: 'account:user-C',
          reason: AccountPurgeReason.signOutReset,
          admission: admD,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );

      // Block detached eviction if guest_claim_recovery_journal has entry for user-C (even with discardUnsyncedMutations: true)
      final freshDetachedC = DetachedAccountEvictionAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
        targetUserId: 'user-C',
      );
      await db.insert('guest_claim_recovery_journal', <String, Object?>{
        'claim_id': 'claim-userC-block',
        'user_id': 'user-C',
        'guest_profile_id': 'g-c',
        'expected_state_fingerprint': 'fp',
        'conflict_decisions': '{}',
        'phase': 'prepared',
        'created_at': 1000,
        'updated_at': 1000,
      });
      await expectLater(
        () => dal.evictDetachedAccountScope(
          ownerScope: 'account:user-C',
          admission: freshDetachedC,
          discardUnsyncedMutations: true,
        ),
        throwsA(isA<PurgeProhibitedError>()),
      );
      await db.delete(
        'guest_claim_recovery_journal',
        where: 'claim_id = ?',
        whereArgs: <Object?>['claim-userC-block'],
      );

      // Race check: journal row inserted in onBeforeCommitHook rolls back detached eviction 100%
      await expectLater(
        () => dal.evictDetachedAccountScope(
          ownerScope: 'account:user-C',
          admission: freshDetachedC,
          discardUnsyncedMutations: true,
          onBeforeCommitHook: (txn) async {
            await txn.insert('guest_claim_recovery_journal', <String, Object?>{
              'claim_id': 'claim-userC-race',
              'user_id': 'user-C',
              'guest_profile_id': 'g-c-race',
              'expected_state_fingerprint': 'fp',
              'conflict_decisions': '{}',
              'phase': 'prepared',
              'created_at': 1000,
              'updated_at': 1000,
            });
          },
        ),
        throwsA(isA<PurgeProhibitedError>()),
      );
      expect(await dal.getSyncMeta('account:user-C'), isNotNull);

      // Valid detached cleanup of user-C (after switch to user-D, no journal, explicit discard=true) succeeds & preserves user-D + offline_chapters
      await dal.evictDetachedAccountScope(
        ownerScope: 'account:user-C',
        admission: freshDetachedC,
        discardUnsyncedMutations: true,
      );
      expect(await dal.getSyncMeta('account:user-C'), isNull);
      expect(await dal.getPendingMutations('account:user-C'), isEmpty);
      expect(await dal.getQuarantinedMutations('account:user-C'), isEmpty);
      expect(await localDao.isBookmarked(ownerScope: 'account:user-C', storyId: 's-user-C'), isFalse);

      // user-D & offline_chapters remain 100% intact
      expect(await dal.getSyncMeta('account:user-D'), isNotNull);
      expect(await dal.getPendingMutations('account:user-D'), hasLength(1));
      expect(await db.query('offline_chapters'), hasLength(1));

      // AccountPurgeReason.accountDeleted while active deletes all 10 account tables & preserves offline_chapters
      await dal.purgeAccountScope(
        ownerScope: 'account:user-D',
        reason: AccountPurgeReason.accountDeleted,
        admission: admD,
      );
      expect(await dal.getSyncMeta('account:user-D'), isNull);
      expect(await dal.getPendingMutations('account:user-D'), isEmpty);
      expect(await dal.getQuarantinedMutations('account:user-D'), isEmpty);
      expect(await localDao.isBookmarked(ownerScope: 'account:user-D', storyId: 's-user-D'), isFalse);
      expect(await db.query('offline_chapters'), hasLength(1));
    });

    test('GuestLifecyclePurgeReason: userClearedGuestData rejects UnusedGuestEvictionAdmission; verifiedUnusedGuestEviction cleans rotated guest without deadlock while protecting active/quarantined/journal guests', () async {
      final mockApiClient = _MockApiClient();
      final mockTokenStorage = _MockTokenStorage();
      final mockSecureStorage = _MockSecureStorage();
      final secureData = <String, String>{};

      when(() => mockSecureStorage.read(key: any(named: 'key')))
          .thenAnswer((inv) async => secureData[inv.namedArguments[#key] as String]);
      when(() => mockSecureStorage.write(key: any(named: 'key'), value: any(named: 'value')))
          .thenAnswer((inv) async {
        secureData[inv.namedArguments[#key] as String] = inv.namedArguments[#value] as String;
      });
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.saveTokens(
            accessToken: any(named: 'accessToken'),
            refreshToken: any(named: 'refreshToken'),
          )).thenAnswer((_) async {});
      when(() => mockTokenStorage.clearTokens()).thenAnswer((_) async {});

      final installProvider = InstallationIdentityProvider(secureStorage: mockSecureStorage, prefs: prefs);
      final guestProvider = GuestProfileIdentityProvider(prefs: prefs);
      final coordinator = ActiveScopeCoordinator(
        installProvider: installProvider,
        guestProfileProvider: guestProvider,
      );
      final authService = AuthService(apiClient: mockApiClient, tokenStorage: mockTokenStorage);
      final bridge = AuthScopeBridge(authService: authService, coordinator: coordinator)..attach();
      addTearDown(bridge.dispose);

      await authService.initializeAuth();
      await bridge.settle();
      expect(coordinator.state, ActiveScopeState.guest);
      final gOld = await guestProvider.getOrCreateGuestProfileId();
      final gOldScope = 'guest:$gOld';
      final t = DateTime.utc(2026, 2, 1);

      await localDao.saveBookmark(
        LocalBookmark(ownerScope: gOldScope, storyId: 's-old', title: 'Old Guest BM', createdAt: t),
      );
      await localDao.saveProgress(
        LocalReadingProgress(
          ownerScope: gOldScope,
          storyId: 's-old',
          chapterId: 'c-1',
          readingMode: 'WEBTOON',
          progressPercentage: 30,
          scrollPosition: 0,
          updatedAt: t,
          deviceTimestamp: t,
        ),
      );
      await localDao.saveHistory(
        LocalReadingHistory(
          ownerScope: gOldScope,
          storyId: 's-old',
          chapterId: 'c-1',
          storyTitle: 'Old',
          chapterNumber: '1',
          progressPercentage: 30,
          lastReadAt: t,
        ),
      );
      await dal.putGuestLocalPreference(
        LocalPreferenceRecord(
          ownerScope: gOldScope,
          prefKey: 'theme',
          value: 'dark',
          updatedAt: t.toIso8601String(),
        ),
        admission: GuestLocalWriteAdmission.captureFromLive(
          coordinator: coordinator,
          authService: authService,
        ),
      );

      // Rotate to fresh gNew via coordinator.onLogout() (creates detached old guest gOld)
      await coordinator.onLogout();
      final gNew = await guestProvider.getOrCreateGuestProfileId();
      final gNewScope = 'guest:$gNew';
      expect(gNew, isNot(gOld));
      expect(coordinator.activeScope, gNewScope);

      await localDao.saveBookmark(
        LocalBookmark(ownerScope: gNewScope, storyId: 's-new', title: 'New Guest BM', createdAt: t),
      );

      // Active guest gNew CANNOT be targeted by UnusedGuestEvictionAdmission
      expect(
        () => UnusedGuestEvictionAdmission.captureFromLive(
          coordinator: coordinator,
          authService: authService,
          targetGuestProfileId: gNew,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );

      // Even if a desynced authority source differs from coordinator, guestProfileId == persisted gNew is rejected
      await expectLater(
        () => dal.purgeGuestLocalScope(
          guestScope: gNewScope,
          reason: GuestLifecyclePurgeReason.verifiedUnusedGuestEviction,
          admission: UnusedGuestEvictionAdmission(
            authoritySource: MutableSyncAuthoritySource.activeGuest('g-other-desync'),
            targetGuestProfileId: gNew,
            expectedGeneration: 1,
          ),
          guestProfileProvider: guestProvider,
        ),
        throwsA(isA<PurgeProhibitedError>()),
      );

      // userClearedGuestData strictly requires GuestLocalWriteAdmission -> rejects UnusedGuestEvictionAdmission
      final evictOldAdm = UnusedGuestEvictionAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
        targetGuestProfileId: gOld,
      );
      await expectLater(
        () => dal.purgeGuestLocalScope(
          guestScope: gOldScope,
          reason: GuestLifecyclePurgeReason.userClearedGuestData,
          admission: evictOldAdm,
          guestProfileProvider: guestProvider,
        ),
        throwsA(isA<PurgeProhibitedError>()),
      );

      // Transitioning (e.g., login started before GuestClaim resolves) blocks verifiedUnusedGuestEviction
      when(() => mockApiClient.post<Map<String, dynamic>>(
            ApiEndpoints.login,
            data: any<dynamic>(named: 'data'),
          )).thenAnswer((_) async => Response<Map<String, dynamic>>(
            requestOptions: RequestOptions(path: ApiEndpoints.login),
            statusCode: 200,
            data: <String, dynamic>{
              'user': <String, dynamic>{
                'id': 'u-guest-evict',
                'username': 'u-guest-evict',
                'email': 'u@omninovel.com',
                'role': 'READER',
              },
              'accessToken': _encodeJwt(<String, Object?>{'sub': 'u-guest-evict', 'sid': 'sid-ge'}),
              'refreshToken': 'refresh-ge',
            },
          ));
      await authService.login(identifier: 'u-guest-evict', password: 'pw');
      await bridge.settle();
      expect(coordinator.state, ActiveScopeState.transitioning);
      await expectLater(
        () => dal.purgeGuestLocalScope(
          guestScope: gOldScope,
          reason: GuestLifecyclePurgeReason.verifiedUnusedGuestEviction,
          admission: evictOldAdm,
          guestProfileProvider: guestProvider,
        ),
        throwsA(isA<SyncAdmissionRejectedError>()),
      );

      // Resolve back to guest (skipClaim / logout) -> gNew is active, gOld is detached unused & unquarantined
      await authService.logout();
      await bridge.settle();
      final gCurrentAfterLogout = await guestProvider.getOrCreateGuestProfileId();
      expect(coordinator.activeScope, 'guest:$gCurrentAfterLogout');
      final freshEvictOldAdm = UnusedGuestEvictionAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
        targetGuestProfileId: gOld,
      );

      await dal.purgeGuestLocalScope(
        guestScope: gOldScope,
        reason: GuestLifecyclePurgeReason.verifiedUnusedGuestEviction,
        admission: freshEvictOldAdm,
        guestProfileProvider: guestProvider,
      );

      // Old guest 4 local tables removed cleanly; fresh guest gNew preserved 100%!
      expect(await localDao.getBookmarks(ownerScope: gOldScope), isEmpty);
      expect(await localDao.getProgress(ownerScope: gOldScope, storyId: 's-old'), isNull);
      expect(await localDao.getHistoryItem(ownerScope: gOldScope, storyId: 's-old', chapterId: 'c-1'), isNull);
      expect(await dal.getGuestLocalPreference(gOldScope, 'theme'), isNull);
      expect(await localDao.isBookmarked(ownerScope: gNewScope, storyId: 's-new'), isTrue);

      // While authenticated as account:u-guest-evict, verifiedUnusedGuestEviction can clean unquarantined guest:gNew while keeping quarantined/account/offline intact
      await authService.login(identifier: 'u-guest-evict', password: 'pw');
      await bridge.settle();
      await coordinator.resolveToAccount(
        'u-guest-evict',
        expectedGeneration: coordinator.transitionGeneration,
      );
      final authAccAdm = AccountWriteAdmission.captureFromLive(
        coordinator: coordinator,
        authService: authService,
      );
      await dal.putBookmarkWithMutation(
        bookmark: LocalBookmark(ownerScope: 'account:u-guest-evict', storyId: 's-acc', title: 'Acc', createdAt: t),
        mutation: PendingMutationRecord.create(
          ownerScope: 'account:u-guest-evict',
          mutationId: 'mut-acc-ge',
          clientId: kTestClientId,
          domain: SyncDomain.bookmark,
          entityId: 's-acc',
          operation: SyncOperation.upsert,
          baseServerRevision: '0',
          payload: const <String, Object?>{'storyId': 's-acc'},
          createdAt: t,
        ),
        admission: authAccAdm,
      );
      await dal.purgeGuestLocalScope(
        guestScope: gNewScope,
        reason: GuestLifecyclePurgeReason.verifiedUnusedGuestEviction,
        admission: UnusedGuestEvictionAdmission.captureFromLive(
          coordinator: coordinator,
          authService: authService,
          targetGuestProfileId: gNew,
        ),
        guestProfileProvider: guestProvider,
      );
      expect(await localDao.getBookmarks(ownerScope: gNewScope), isEmpty);
      expect(await localDao.isBookmarked(ownerScope: 'account:u-guest-evict', storyId: 's-acc'), isTrue);
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

class _InterleavingDeleteDatabase extends Fake implements Database {
  final Database _inner;
  final int triggerAfterDeleteCount;
  final Future<void> Function() onDeleteThresholdReached;

  _InterleavingDeleteDatabase(
    this._inner, {
    required this.triggerAfterDeleteCount,
    required this.onDeleteThresholdReached,
  });

  @override
  Future<T> transaction<T>(
    Future<T> Function(Transaction txn) action, {
    bool? exclusive,
  }) {
    return _inner.transaction<T>((txn) {
      final wrapped = _InterleavingDeleteTransaction(
        txn,
        triggerAfterDeleteCount: triggerAfterDeleteCount,
        onDeleteThresholdReached: onDeleteThresholdReached,
      );
      return action(wrapped);
    }, exclusive: exclusive);
  }
}

class _InterleavingDeleteTransaction extends Fake implements Transaction {
  final Transaction _inner;
  final int triggerAfterDeleteCount;
  final Future<void> Function() onDeleteThresholdReached;
  int _deleteCount = 0;

  _InterleavingDeleteTransaction(
    this._inner, {
    required this.triggerAfterDeleteCount,
    required this.onDeleteThresholdReached,
  });

  @override
  Future<int> delete(
    String table, {
    String? where,
    List<Object?>? whereArgs,
  }) async {
    final res = await _inner.delete(table, where: where, whereArgs: whereArgs);
    _deleteCount++;
    if (_deleteCount == triggerAfterDeleteCount) {
      await onDeleteThresholdReached();
    }
    return res;
  }

  @override
  Future<List<Map<String, Object?>>> query(
    String table, {
    bool? distinct,
    List<String>? columns,
    String? where,
    List<Object?>? whereArgs,
    String? groupBy,
    String? having,
    String? orderBy,
    int? limit,
    int? offset,
  }) {
    return _inner.query(
      table,
      distinct: distinct,
      columns: columns,
      where: where,
      whereArgs: whereArgs,
      groupBy: groupBy,
      having: having,
      orderBy: orderBy,
      limit: limit,
      offset: offset,
    );
  }

  @override
  Future<int> insert(
    String table,
    Map<String, Object?> values, {
    String? nullColumnHack,
    ConflictAlgorithm? conflictAlgorithm,
  }) {
    return _inner.insert(
      table,
      values,
      nullColumnHack: nullColumnHack,
      conflictAlgorithm: conflictAlgorithm,
    );
  }
}
