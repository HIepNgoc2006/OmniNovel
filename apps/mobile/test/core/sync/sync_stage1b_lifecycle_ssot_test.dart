import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:dio/dio.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/app/bootstrap.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/auth/token_storage.dart';
import 'package:omninovel_mobile/core/claim/guest_claim_coordinator.dart';
import 'package:omninovel_mobile/core/claim/models/guest_claim_models.dart';
import 'package:omninovel_mobile/core/claim/scope_coordinator_claim_bridge.dart';
import 'package:omninovel_mobile/core/identity/active_scope_coordinator.dart';
import 'package:omninovel_mobile/core/identity/guest_profile_identity_provider.dart';
import 'package:omninovel_mobile/core/storage/local_library_dao.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/sync/authority/sync_write_admission.dart';
import 'package:omninovel_mobile/core/sync/errors/sync_storage_exceptions.dart';
import 'package:omninovel_mobile/core/sync/models/sync_models.dart';
import 'package:omninovel_mobile/core/sync/storage/sync_storage_dal.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'sync_test_helpers.dart';

class _MockApiClient extends Mock implements ApiClient {}

class _MockSecureStorage extends Mock implements FlutterSecureStorage {}

class _MockTokenStorage extends Mock implements ITokenStorage {}

class _FakeScopeClaimBridge implements ScopeCoordinatorClaimBridge {
  int _generation = 1;
  final List<Map<String, Object?>> resolveCalls = <Map<String, Object?>>[];
  final List<String> pendingUnavailableCalls = <String>[];

  @override
  int get transitionGeneration => _generation;

  void bumpGeneration() => _generation++;

  @override
  Future<void> resolveToAccount(
    String userId, {
    required int expectedGeneration,
  }) async {
    if (expectedGeneration != _generation) {
      throw StateError(
        'Stale resolve: expectedGeneration=$expectedGeneration != $_generation',
      );
    }
    resolveCalls.add(<String, Object?>{
      'userId': userId,
      'expectedGeneration': expectedGeneration,
    });
  }

  @override
  void markPendingUnavailable(String message) {
    pendingUnavailableCalls.add(message);
  }
}

class _FakeAuthService extends Fake implements AuthService {
  AuthState _state;
  _FakeAuthService(this._state);

  @override
  AuthState get state => _state;

  void setUser(User? user) {
    if (user == null) {
      _state = AuthState.unauthenticated();
    } else {
      _state = AuthState.authenticated(user: user, accessToken: 'tok-stage1b');
    }
  }
}

/// Pure-Dart in-memory [SharedPreferences] không chạm Flutter MethodChannel,
/// dùng an toàn bên trong `Isolate.spawn` và cross-thread concurrency tests.
class _PureDartSharedPrefs extends Fake implements SharedPreferences {
  final Map<String, Object> _store;

  _PureDartSharedPrefs([Map<String, Object>? initialValues])
      : _store = Map<String, Object>.from(initialValues ?? <String, Object>{});

  @override
  String? getString(String key) => _store[key] as String?;

  @override
  Future<bool> setString(String key, String value) async {
    _store[key] = value;
    return true;
  }

  @override
  bool? getBool(String key) => _store[key] as bool?;

  @override
  Future<bool> setBool(String key, bool value) async {
    _store[key] = value;
    return true;
  }

  @override
  List<String>? getStringList(String key) {
    final val = _store[key];
    if (val is List<String>) {
      return List<String>.of(val);
    }
    return null;
  }

  @override
  Future<bool> setStringList(String key, List<String> value) async {
    _store[key] = List<String>.of(value);
    return true;
  }

  @override
  bool containsKey(String key) => _store.containsKey(key);

  @override
  Set<String> getKeys() => _store.keys.toSet();

  @override
  Future<bool> remove(String key) async {
    _store.remove(key);
    return true;
  }
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

  const userId = 'u-stage1b-1';
  const testClaimId = 'claim-stage1b-1';
  const testFingerprint =
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  Map<String, dynamic> buildPreviewJson({String claimId = testClaimId}) {
    return <String, dynamic>{
      'claimId': claimId,
      'status': 'PREPARED',
      'stateFingerprint': testFingerprint,
      'expiresAt': '2026-11-15T12:00:00.000Z',
      'bookmarksToImport': 1,
      'historyToImport': 1,
      'progressToImport': 1,
      'conflictsCount': 0,
      'readStatesIgnoredAntiResurrectionCount': 0,
      'conflicts': <Map<String, dynamic>>[],
    };
  }

  Map<String, dynamic> buildFinalizationJson() {
    return <String, dynamic>{
      'tombstonedStoryIds': <String>[],
      'finalizedProgress': <Map<String, dynamic>>[
        <String, dynamic>{
          'storyId': 'story-claim-1',
          'chapterId': 'chap-1',
          'chapterVersionId': 'ver-1',
          'readingMode': 'PAGED',
          'pageIndex': 4,
          'scrollPosition': 0.0,
          'progressPercentage': 60.0,
          'anchorBlockId': null,
          'textOffset': null,
          'updatedAt': '2026-11-09T12:00:00.000Z',
          'deviceTimestamp': 1700000000000,
        },
      ],
      'finalizedChapterReadStates': <Map<String, dynamic>>[
        <String, dynamic>{
          'storyId': 'story-claim-1',
          'chapterId': 'chap-1',
          'chapterVersionId': 'ver-1',
          'progressPercentage': 60.0,
          'completedAt': null,
          'lastReadAt': '2026-11-09T12:00:00.000Z',
        },
      ],
    };
  }

  Future<void> seedAllFourGuestLocalTables(
    String guestProfileId, {
    LocalLibraryDao? targetDao,
    SyncStorageDal? targetDal,
    GuestLocalWriteAdmission? admission,
  }) async {
    final gScope = 'guest:$guestProfileId';
    final d = targetDao ?? localDao;
    final s = targetDal ?? dal;
    final adm = admission ?? testGuestAdmission(gScope);
    final now = DateTime.utc(2026, 11, 9, 10, 0);

    await d.saveBookmark(
      LocalBookmark(
        ownerScope: gScope,
        storyId: 'story-claim-1',
        title: 'Claim Story 1',
        createdAt: now,
      ),
    );
    await d.saveProgress(
      LocalReadingProgress(
        ownerScope: gScope,
        storyId: 'story-claim-1',
        chapterId: 'chap-1',
        readingMode: 'WEBTOON',
        progressPercentage: 45.0,
        scrollPosition: 120.0,
        updatedAt: now,
        deviceTimestamp: now,
      ),
    );
    await d.saveHistory(
      LocalReadingHistory(
        ownerScope: gScope,
        storyId: 'story-claim-1',
        chapterId: 'chap-1',
        storyTitle: 'Claim Story 1',
        chapterNumber: '1',
        progressPercentage: 45.0,
        lastReadAt: now,
      ),
    );
    await s.putGuestLocalPreference(
      LocalPreferenceRecord(
        ownerScope: gScope,
        prefKey: 'theme',
        value: 'sepia',
        updatedAt: now.toIso8601String(),
      ),
      admission: adm,
    );
  }

  GuestClaimCoordinator buildCoordinator({
    required GuestProfileIdentityProvider guestProvider,
    required _MockApiClient apiClient,
    required _FakeScopeClaimBridge bridge,
    required _FakeAuthService authService,
    OfflineDatabase? customOfflineDb,
    LocalLibraryDao? customDao,
    SharedPreferences? customPrefs,
  }) {
    return GuestClaimCoordinator(
      dao: customDao ?? localDao,
      scopeBridge: bridge,
      guestProvider: guestProvider,
      apiClient: apiClient,
      offlineDb: customOfflineDb ?? offlineDb,
      authService: authService,
      prefs: customPrefs ?? prefs,
    );
  }

  setUp(() async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    prefs = await SharedPreferences.getInstance();

    tempDir = await Directory.systemTemp.createTemp('omninovel_stage1b_ssot_');
    dbPath = p.join(tempDir.path, 'stage1b_ssot.db');
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

  group('Stage 1B T3 & T4: SQLite v6 Quarantine SSoT & Legacy Migration', () {
    test(
      'T3: migrateLegacyQuarantinesToSqlite trims/dedupes idempotently, preserves original timestamp, & writes 0 items back to SharedPreferences',
      () async {
        final legacyList = <String>[
          '',
          '   ',
          ' g-1 ',
          'g-1',
          'g-2',
          '\tg-2\n',
        ];
        SharedPreferences.setMockInitialValues(<String, Object>{
          GuestProfileIdentityProvider.keyQuarantinedProfiles: legacyList,
        });
        prefs = await SharedPreferences.getInstance();

        final guestProvider = GuestProfileIdentityProvider(
          prefs: prefs,
          offlineDatabase: offlineDb,
        );

        // Chạy song song 2 lần để kiểm chứng single-flight _inFlightMigration + idempotency
        await Future.wait(<Future<void>>[
          guestProvider.migrateLegacyQuarantinesToSqlite(),
          guestProvider.migrateLegacyQuarantinesToSqlite(),
        ]);

        expect(
          prefs.getBool(
            GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6,
          ),
          isTrue,
        );

        final migratedRows = await offlineDb.database.query(
          'guest_quarantined_scopes',
          orderBy: 'guest_profile_id ASC',
        );
        expect(migratedRows, hasLength(2));
        expect(migratedRows[0]['guest_profile_id'], 'g-1');
        expect(migratedRows[0]['reason'], 'LEGACY_PREFS_MIGRATED');
        expect(migratedRows[1]['guest_profile_id'], 'g-2');
        final origTs1 = migratedRows[0]['quarantined_at_ms'] as int;
        final origTs2 = migratedRows[1]['quarantined_at_ms'] as int;

        // Re-run sau khi reset flag -> phải idempotent, KHÔNG ghi đè timestamp cũ
        await Future<void>.delayed(const Duration(milliseconds: 5));
        await prefs.setBool(
          GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6,
          false,
        );
        await guestProvider.migrateLegacyQuarantinesToSqlite();

        final afterRerunRows = await offlineDb.database.query(
          'guest_quarantined_scopes',
          orderBy: 'guest_profile_id ASC',
        );
        expect(afterRerunRows, hasLength(2));
        expect(afterRerunRows[0]['quarantined_at_ms'], origTs1);
        expect(afterRerunRows[1]['quarantined_at_ms'], origTs2);

        // Legacy SharedPreferences là read-only shadow (không bị xóa, không bị ghi thêm)
        expect(
          prefs.getStringList(
            GuestProfileIdentityProvider.keyQuarantinedProfiles,
          ),
          equals(legacyList),
        );

        // Quarantine mới CHỈ ghi vào SQLite v6, tuyệt đối không ghi vào SharedPreferences
        await guestProvider.quarantineGuestScope('g-3', sourceUserId: userId);
        expect(await guestProvider.isGuestScopeQuarantined('g-3'), isTrue);
        expect(
          await guestProvider.listQuarantinedGuestScopes(),
          equals(<String>['g-1', 'g-2', 'g-3']),
        );
        expect(
          prefs.getStringList(
            GuestProfileIdentityProvider.keyQuarantinedProfiles,
          ),
          equals(legacyList),
        );

        // Fail-closed nếu caller tạo provider thiếu OfflineDatabase rồi gọi quarantineGuestScope
        final providerWithoutDb = GuestProfileIdentityProvider(prefs: prefs);
        await expectLater(
          () => providerWithoutDb.quarantineGuestScope('g-no-db'),
          throwsA(
            isA<StateError>().having(
              (e) => e.message,
              'message',
              contains('SQLITE_SSOT_REQUIRED'),
            ),
          ),
        );
      },
    );

    test(
      'T4: PURGED tombstone beats legacy SharedPreferences backup conflict both pre-migration and during migration',
      () async {
        // Seed terminal PURGED tombstone cho 'g-purged' (giả lập .db đã purge từ trước,
        // trong khi cloud backup vừa restore SharedPreferences cũ chứa ['g-purged', 'g-kept'])
        await offlineDb.database.insert(
          'guest_purged_tombstones',
          <String, Object?>{
            'guest_profile_id': 'g-purged',
            'purged_at_ms': DateTime.utc(2026, 11, 9).millisecondsSinceEpoch,
            'purge_reason': 'USER_CLEARED_GUEST_DATA',
            'purged_by_user_id': null,
          },
        );
        SharedPreferences.setMockInitialValues(<String, Object>{
          GuestProfileIdentityProvider.keyQuarantinedProfiles: <String>[
            'g-purged',
            'g-kept',
          ],
        });
        prefs = await SharedPreferences.getInstance();

        final guestProvider = GuestProfileIdentityProvider(
          prefs: prefs,
          offlineDatabase: offlineDb,
        );

        // 1. Ngay cả TRƯỚC KHI migrated_v6 == true:
        expect(await guestProvider.isGuestScopePurged('g-purged'), isTrue);
        expect(await guestProvider.isGuestScopeQuarantined('g-purged'), isFalse);
        expect(await guestProvider.isGuestScopeQuarantined('g-kept'), isTrue);

        // Dùng explicit txn để kiểm chứng nhánh pre-migration union trong listQuarantinedGuestScopes
        await offlineDb.database.transaction((txn) async {
          final preMigList = await guestProvider.listQuarantinedGuestScopes(
            txn: txn,
          );
          expect(preMigList, equals(<String>['g-kept']));
        });

        // 2. Chạy migrateLegacyQuarantinesToSqlite -> không được resurrect 'g-purged'
        await guestProvider.migrateLegacyQuarantinesToSqlite();

        expect(
          prefs.getBool(
            GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6,
          ),
          isTrue,
        );
        final rows = await offlineDb.database.query('guest_quarantined_scopes');
        expect(rows, hasLength(1));
        expect(rows.first['guest_profile_id'], 'g-kept');

        expect(await guestProvider.isGuestScopeQuarantined('g-purged'), isFalse);
        expect(await guestProvider.isGuestScopeQuarantined('g-kept'), isTrue);

        await expectLater(
          () => guestProvider.quarantineGuestScope('g-purged'),
          throwsA(
            isA<GuestLifecycleStateError>().having(
              (e) => e.message,
              'message',
              contains('GUEST_ALREADY_PURGED'),
            ),
          ),
        );
      },
    );
  });

  group('Stage 1B T5 & T6: Crash Recovery Matrix & Active Clear Auto-Rotation', () {
    test(
      'T5: Crash atomicity for skipClaim, purgeGuestLocalScope, legacy migration, and orphan prepared journal cleanup',
      () async {
        const g1 = 'g-t5-skip-crash';
        SharedPreferences.setMockInitialValues(<String, Object>{
          GuestProfileIdentityProvider.keyGuestProfileId: g1,
          GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6: true,
        });
        prefs = await SharedPreferences.getInstance();
        final guestProvider = GuestProfileIdentityProvider(
          prefs: prefs,
          offlineDatabase: offlineDb,
        );

        await seedAllFourGuestLocalTables(g1);

        final mockApi = _MockApiClient();
        final bridge = _FakeScopeClaimBridge();
        final authService = _FakeAuthService(
          AuthState.authenticated(
            user: const User(
              id: userId,
              username: 'stage1b',
              email: 's1b@omni.dev',
              role: 'READER',
            ),
            accessToken: 'tok',
          ),
        );

        when(
          () => mockApi.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimPrepare,
            data: any<dynamic>(named: 'data'),
          ),
        ).thenAnswer(
          (_) async => Response<Map<String, dynamic>>(
            requestOptions: RequestOptions(path: ApiEndpoints.guestClaimPrepare),
            statusCode: 200,
            data: buildPreviewJson(),
          ),
        );

        final coordinator = buildCoordinator(
          guestProvider: guestProvider,
          apiClient: mockApi,
          bridge: bridge,
          authService: authService,
        );
        await coordinator.checkAndPrepareClaim(userId);
        expect(coordinator.isOpen, isTrue);

        // T5a: Crash trong skipClaim() giữa INSERT quarantine và DELETE journal
        await expectLater(
          () => coordinator.skipClaim(
            userId,
            onAfterQuarantineBeforeJournalDeleteHook: (_) async {
              throw StateError('SIMULATED_CRASH_SKIP_CLAIM');
            },
          ),
          throwsStateError,
        );
        // SQLite rollback 100%: quarantine trống, journal còn nguyên 'prepared', bridge chưa resolve
        expect(await offlineDb.database.query('guest_quarantined_scopes'), isEmpty);
        expect(await guestProvider.isGuestScopeQuarantined(g1), isFalse);
        expect(
          await offlineDb.database.query('guest_claim_recovery_journal'),
          hasLength(1),
        );
        expect(bridge.resolveCalls, isEmpty);
        expect(await localDao.isBookmarked(ownerScope: 'guest:$g1', storyId: 'story-claim-1'), isTrue);

        // Khởi động lại Coordinator mới -> checkCrashRecovery phục hồi modal 'prepared' cleanly
        final restartedCoord = buildCoordinator(
          guestProvider: guestProvider,
          apiClient: mockApi,
          bridge: bridge,
          authService: authService,
        );
        final recovery = await restartedCoord.checkCrashRecovery(userId);
        expect(recovery, CrashRecoveryResult.userActionRequired);
        expect(restartedCoord.isOpen, isTrue);
        expect(restartedCoord.previewData?.claimId, testClaimId);

        // T5b: Crash trong purgeGuestLocalScope giữa DELETE local_* và INSERT tombstone
        const gPurgeCrash = 'g-t5-purge-crash';
        await seedAllFourGuestLocalTables(gPurgeCrash);
        await expectLater(
          () => dal.purgeGuestLocalScope(
            guestScope: 'guest:$gPurgeCrash',
            reason: GuestLifecyclePurgeReason.verifiedUnusedGuestEviction,
            admission: testUnusedGuestAdmission(
              'guest:$gPurgeCrash',
              activeAccountUserId: userId,
            ),
            guestProfileProvider: guestProvider,
            onAfterDeleteBeforeTombstoneHook: (_) async {
              throw StateError('SIMULATED_CRASH_PURGE_MID_TX');
            },
          ),
          throwsStateError,
        );
        expect(
          await localDao.isBookmarked(
            ownerScope: 'guest:$gPurgeCrash',
            storyId: 'story-claim-1',
          ),
          isTrue,
        );
        expect(
          await localDao.getProgress(
            ownerScope: 'guest:$gPurgeCrash',
            storyId: 'story-claim-1',
          ),
          isNotNull,
        );
        expect(
          await localDao.getHistoryItem(
            ownerScope: 'guest:$gPurgeCrash',
            storyId: 'story-claim-1',
            chapterId: 'chap-1',
          ),
          isNotNull,
        );
        expect(
          (await dal.getGuestLocalPreference('guest:$gPurgeCrash', 'theme'))
              ?.value,
          'sepia',
        );
        expect(await guestProvider.isGuestScopePurged(gPurgeCrash), isFalse);

        // T5c: Crash trong migrateLegacyQuarantinesToSqlite trước commit & trước khi đặt migrated_v6
        SharedPreferences.setMockInitialValues(<String, Object>{
          GuestProfileIdentityProvider.keyQuarantinedProfiles: <String>['g-mig'],
        });
        prefs = await SharedPreferences.getInstance();
        final migProvider = GuestProfileIdentityProvider(
          prefs: prefs,
          offlineDatabase: offlineDb,
        );
        await expectLater(
          () => migProvider.migrateLegacyQuarantinesToSqlite(
            onBeforeCommitHook: (_) async {
              throw StateError('CRASH_MIG_BEFORE_COMMIT');
            },
          ),
          throwsStateError,
        );
        expect(
          await offlineDb.database.query(
            'guest_quarantined_scopes',
            where: 'guest_profile_id = ?',
            whereArgs: <Object?>['g-mig'],
          ),
          isEmpty,
        );
        expect(
          prefs.getBool(
            GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6,
          ),
          isNot(isTrue),
        );

        await expectLater(
          () => migProvider.migrateLegacyQuarantinesToSqlite(
            onBeforeSetMigratedFlagHook: () async {
              throw StateError('CRASH_MIG_BEFORE_FLAG');
            },
          ),
          throwsStateError,
        );
        // SQLite đã commit nhưng flag chưa bật -> rerun vẫn idempotent và đặt flag thành công
        expect(
          await offlineDb.database.query(
            'guest_quarantined_scopes',
            where: 'guest_profile_id = ?',
            whereArgs: <Object?>['g-mig'],
          ),
          hasLength(1),
        );
        expect(
          prefs.getBool(
            GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6,
          ),
          isNot(isTrue),
        );
        await migProvider.migrateLegacyQuarantinesToSqlite();
        expect(
          prefs.getBool(
            GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6,
          ),
          isTrue,
        );

        // T5d: Orphan 'prepared' journal khi Guest đã mang terminal PURGED tombstone -> checkCrashRecovery dọn fail-closed
        await offlineDb.database.insert(
          'guest_purged_tombstones',
          <String, Object?>{
            'guest_profile_id': g1,
            'purged_at_ms': DateTime.utc(2026, 11, 9).millisecondsSinceEpoch,
            'purge_reason': 'USER_CLEARED_GUEST_DATA',
            'purged_by_user_id': null,
          },
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
        final postPurgeCoord = buildCoordinator(
          guestProvider: guestProvider,
          apiClient: mockApi,
          bridge: bridge,
          authService: authService,
        );
        final orphanRecovery = await postPurgeCoord.checkCrashRecovery(userId);
        expect(orphanRecovery, CrashRecoveryResult.noPending);
        expect(postPurgeCoord.isOpen, isFalse);
        expect(
          await offlineDb.database.query(
            'guest_claim_recovery_journal',
            where: 'claim_id = ?',
            whereArgs: <Object?>[testClaimId],
          ),
          isEmpty,
        );
      },
    );

    test(
      'T6: userClearedGuestData crash after SQLite commit before rotation auto-rotates gOld -> gNew on next getOrCreateGuestProfileId() and AppBootstrap.run()',
      () async {
        const gOld = '11111111-1111-4111-8111-aaaaaaaaaaa1';
        SharedPreferences.setMockInitialValues(<String, Object>{
          GuestProfileIdentityProvider.keyGuestProfileId: gOld,
          GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6: true,
        });
        prefs = await SharedPreferences.getInstance();

        final guestProvider = GuestProfileIdentityProvider(
          prefs: prefs,
          offlineDatabase: offlineDb,
        );
        await seedAllFourGuestLocalTables(gOld);

        // 1. Giả lập userClearedGuestData commit xóa + PURGED tombstone xong nhưng crash TRƯỚC khi kịp xoay ID
        await expectLater(
          () => dal.purgeGuestLocalScope(
            guestScope: 'guest:$gOld',
            reason: GuestLifecyclePurgeReason.userClearedGuestData,
            admission: testGuestAdmission('guest:$gOld'),
            guestProfileProvider: guestProvider,
            onAfterCommitBeforeRotateHook: () async {
              throw StateError('CRASH_AFTER_COMMIT_BEFORE_ROTATE');
            },
          ),
          throwsStateError,
        );

        // Đã commit SQLite xóa dữ liệu + ghi tombstone, nhưng Prefs vẫn còn kẹt gOld!
        expect(
          await localDao.hasGuestData('guest:$gOld'),
          isFalse,
        );
        expect(await guestProvider.isGuestScopePurged(gOld), isTrue);
        expect(await guestProvider.peekGuestProfileId(), gOld);

        // 2. Phục hồi cấp Provider (fresh instance đọc cùng prefs + db):
        final providerRecovery = GuestProfileIdentityProvider(
          prefs: prefs,
          offlineDatabase: offlineDb,
        );
        final gNewFromProvider = await providerRecovery.getOrCreateGuestProfileId();
        expect(gNewFromProvider, isNotEmpty);
        expect(gNewFromProvider, isNot(equals(gOld)));
        expect(await providerRecovery.isGuestScopePurged(gOld), isTrue);
        expect(await providerRecovery.isGuestScopePurged(gNewFromProvider), isFalse);

        // 3. Phục hồi đầy đủ qua AppBootstrap.run() thật nếu đặt lại trạng thái kẹt gOld trong Prefs:
        await prefs.setString(
          GuestProfileIdentityProvider.keyGuestProfileId,
          gOld,
        );
        final mockSecureStorage = _MockSecureStorage();
        final mockTokenStorage = _MockTokenStorage();
        when(() => mockSecureStorage.read(key: any(named: 'key')))
            .thenAnswer((_) async => null);
        when(
          () => mockSecureStorage.write(
            key: any(named: 'key'),
            value: any(named: 'value'),
          ),
        ).thenAnswer((_) async {});
        when(() => mockTokenStorage.getAccessToken())
            .thenAnswer((_) async => null);
        when(() => mockTokenStorage.getRefreshToken())
            .thenAnswer((_) async => null);

        final bootResult = await AppBootstrap.run(
          customOfflineDatabase: offlineDb,
          customSecureStorage: mockSecureStorage,
          customTokenStorage: mockTokenStorage,
        );
        addTearDown(bootResult.authScopeBridge.dispose);

        expect(bootResult.activeScopeCoordinator.state, ActiveScopeState.guest);
        final gBootActive = bootResult.preferencesService.rawPrefs.getString(
          GuestProfileIdentityProvider.keyGuestProfileId,
        );
        expect(gBootActive, isNotNull);
        expect(gBootActive, isNot(equals(gOld)));
        expect(
          bootResult.activeScopeCoordinator.activeScope,
          'guest:$gBootActive',
        );

        // gOld vẫn giữ trạng thái terminal PURGED -> cấm quarantine lại
        await expectLater(
          () => GuestProfileIdentityProvider(
            prefs: bootResult.preferencesService.rawPrefs,
            offlineDatabase: offlineDb,
          ).quarantineGuestScope(gOld),
          throwsA(isA<GuestLifecycleStateError>()),
        );
      },
    );
  });

  group('Stage 1B T7 & T8: Two-Connection, Cross-Isolate & 50-Iteration Stress Races', () {
    test(
      'T7: Two-connection SQLite WAL contention rejects BOTH quarantine-before-purge (skipClaim -> PurgeProhibitedError) and purge-before-quarantine (purge -> GuestLifecycleStateError)',
      () async {
        // ===== Direction 1: quarantine-before-purge =====
        // Connection A (Parent worker isolate via databaseFactoryFfi) chạy skipClaim giữ lock 150ms.
        // Connection B (Spawned Isolate OS Thread via databaseFactoryFfiNoIsolate) tranh chấp purgeGuestLocalScope.
        const g1 = 'g-t7-q-before-p';
        SharedPreferences.setMockInitialValues(<String, Object>{
          GuestProfileIdentityProvider.keyGuestProfileId: g1,
          GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6: true,
        });
        prefs = await SharedPreferences.getInstance();
        final guestProvider = GuestProfileIdentityProvider(
          prefs: prefs,
          offlineDatabase: offlineDb,
        );
        await seedAllFourGuestLocalTables(g1);

        final mockApi = _MockApiClient();
        final bridge = _FakeScopeClaimBridge();
        final authService = _FakeAuthService(
          AuthState.authenticated(
            user: const User(
              id: userId,
              username: 't7',
              email: 't7@omni.dev',
              role: 'READER',
            ),
            accessToken: 'tok',
          ),
        );
        when(
          () => mockApi.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimPrepare,
            data: any<dynamic>(named: 'data'),
          ),
        ).thenAnswer(
          (_) async => Response<Map<String, dynamic>>(
            requestOptions: RequestOptions(path: ApiEndpoints.guestClaimPrepare),
            statusCode: 200,
            data: buildPreviewJson(claimId: 'claim-t7-1'),
          ),
        );
        final coord1 = buildCoordinator(
          guestProvider: guestProvider,
          apiClient: mockApi,
          bridge: bridge,
          authService: authService,
        );
        await coord1.checkAndPrepareClaim(userId);
        expect(coord1.isOpen, isTrue);

        final lockHeld1 = Completer<void>();
        final readyPort1 = ReceivePort();
        final resultPort1 = ReceivePort();
        final exitPort1 = ReceivePort();

        try {
          await Isolate.spawn<_SingleOpWorkerConfig>(
            _singleOpWorkerEntry,
            _SingleOpWorkerConfig(
              dbPath: dbPath,
              guestProfileId: g1,
              operation: _WorkerOperation.purgeUnusedGuest,
              holdMs: 0,
              readyPort: readyPort1.sendPort,
              lockHeldPort: null,
              resultPort: resultPort1.sendPort,
            ),
            onExit: exitPort1.sendPort,
          );
          final cmd1 = await readyPort1.first;
          if (cmd1 is! SendPort) {
            fail('Child worker 1 init failed: $cmd1');
          }

          final skipFuture = coord1.skipClaim(
            userId,
            onBeforeCommitHook: (_) async {
              if (!lockHeld1.isCompleted) lockHeld1.complete();
              await Future<void>.delayed(const Duration(milliseconds: 160));
            },
          );

          await lockHeld1.future;
          cmd1.send('go');

          await skipFuture;
          final childRes1 = (await resultPort1.first)! as Map<Object?, Object?>;
          await exitPort1.first;

          expect(childRes1['status'], 'error', reason: 'childRes1=$childRes1');
          expect(
            childRes1['isPurgeProhibited'],
            isTrue,
            reason: 'Expected PurgeProhibitedError, got $childRes1',
          );
          expect(await guestProvider.isGuestScopeQuarantined(g1), isTrue);
          expect(await guestProvider.isGuestScopePurged(g1), isFalse);
          expect(
            await localDao.isBookmarked(
              ownerScope: 'guest:$g1',
              storyId: 'story-claim-1',
            ),
            isTrue,
          );
          expect(
            await offlineDb.database.query(
              'guest_claim_recovery_journal',
              where: 'claim_id = ?',
              whereArgs: <Object?>['claim-t7-1'],
            ),
            isEmpty,
          );
        } finally {
          readyPort1.close();
          resultPort1.close();
          exitPort1.close();
        }

        // ===== Direction 2: purge-before-quarantine =====
        // Child worker (OS Thread B) chạy purgeGuestLocalScope giữ write lock 160ms sau khi ghi PURGED tombstone.
        // Parent (worker isolate A) gọi skipClaim (hoặc quarantineGuestScope) ngay khi lock được giữ.
        const g2 = 'g-t7-p-before-q';
        await prefs.setString(
          GuestProfileIdentityProvider.keyGuestProfileId,
          g2,
        );
        await seedAllFourGuestLocalTables(g2);

        final coord2 = buildCoordinator(
          guestProvider: guestProvider,
          apiClient: mockApi,
          bridge: bridge,
          authService: authService,
        );
        when(
          () => mockApi.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimPrepare,
            data: any<dynamic>(named: 'data'),
          ),
        ).thenAnswer(
          (_) async => Response<Map<String, dynamic>>(
            requestOptions: RequestOptions(path: ApiEndpoints.guestClaimPrepare),
            statusCode: 200,
            data: buildPreviewJson(claimId: 'claim-t7-2'),
          ),
        );
        await coord2.checkAndPrepareClaim(userId);
        expect(coord2.isOpen, isTrue);

        // Để cho phép Worker B purge theo đúng điều kiện no-journal của T7 purge-before-quarantine race,
        // mô phỏng kịch bản: user đang ở màn hình xác nhận skip, trong khi journal chưa tồn tại (hoặc vừa cleanup),
        // còn Worker B giữ write lock purgeGuestLocalScope và commit PURGED tombstone TRƯỚC skipClaim!
        await offlineDb.database.delete(
          'guest_claim_recovery_journal',
          where: 'claim_id = ?',
          whereArgs: <Object?>['claim-t7-2'],
        );

        final readyPort2 = ReceivePort();
        final lockHeldPort2 = ReceivePort();
        final resultPort2 = ReceivePort();
        final exitPort2 = ReceivePort();

        try {
          await Isolate.spawn<_SingleOpWorkerConfig>(
            _singleOpWorkerEntry,
            _SingleOpWorkerConfig(
              dbPath: dbPath,
              guestProfileId: g2,
              operation: _WorkerOperation.purgeUnusedGuest,
              holdMs: 160,
              readyPort: readyPort2.sendPort,
              lockHeldPort: lockHeldPort2.sendPort,
              resultPort: resultPort2.sendPort,
            ),
            onExit: exitPort2.sendPort,
          );
          final cmd2 = await readyPort2.first;
          if (cmd2 is! SendPort) {
            fail('Child worker 2 init failed: $cmd2');
          }

          cmd2.send('go');
          await lockHeldPort2.first;

          await expectLater(
            () => coord2.skipClaim(userId),
            throwsA(
              isA<GuestLifecycleStateError>().having(
                (e) => e.message,
                'message',
                contains('GUEST_ALREADY_PURGED'),
              ),
            ),
          );

          final childRes2 = (await resultPort2.first)! as Map<Object?, Object?>;
          await exitPort2.first;

          expect(childRes2['status'], 'ok', reason: 'childRes2=$childRes2');
          expect(await guestProvider.isGuestScopePurged(g2), isTrue);
          expect(await guestProvider.isGuestScopeQuarantined(g2), isFalse);
          expect(await localDao.hasGuestData('guest:$g2'), isFalse);
          expect(
            await offlineDb.database.query(
              'guest_quarantined_scopes',
              where: 'guest_profile_id = ?',
              whereArgs: <Object?>[g2],
            ),
            isEmpty,
          );
        } finally {
          readyPort2.close();
          lockHeldPort2.close();
          resultPort2.close();
          exitPort2.close();
        }
      },
    );

    test(
      'T8a: Cross-isolate (Isolate.spawn) race with PureDartSharedPrefs & WAL busy_timeout enforces mutual exclusion in both winner directions',
      () async {
        // Subcase 1: Parent (databaseFactoryFfi) holds quarantine lock -> Child Isolate.spawn purge fails with PurgeProhibitedError
        const gCase1 = 'g-t8a-quar-wins';
        await seedAllFourGuestLocalTables(gCase1);

        final purePrefs = _PureDartSharedPrefs(<String, Object>{
          GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6: true,
        });
        final parentGuestProvider = GuestProfileIdentityProvider(
          prefs: purePrefs,
          offlineDatabase: offlineDb,
        );

        final readyA = ReceivePort();
        final resA = ReceivePort();
        final exitA = ReceivePort();
        final heldA = Completer<void>();

        try {
          await Isolate.spawn<_SingleOpWorkerConfig>(
            _singleOpWorkerEntry,
            _SingleOpWorkerConfig(
              dbPath: dbPath,
              guestProfileId: gCase1,
              operation: _WorkerOperation.purgeUnusedGuest,
              holdMs: 0,
              readyPort: readyA.sendPort,
              lockHeldPort: null,
              resultPort: resA.sendPort,
            ),
            onExit: exitA.sendPort,
          );
          final cmdA = await readyA.first as SendPort;

          final quarFut = parentGuestProvider.quarantineGuestScope(
            gCase1,
            sourceUserId: userId,
            onBeforeCommitHook: (_) async {
              if (!heldA.isCompleted) heldA.complete();
              await Future<void>.delayed(const Duration(milliseconds: 140));
            },
          );
          await heldA.future;
          cmdA.send('go');

          await quarFut;
          final childOutA = (await resA.first)! as Map<Object?, Object?>;
          await exitA.first;

          expect(childOutA['status'], 'error', reason: '$childOutA');
          expect(childOutA['isPurgeProhibited'], isTrue, reason: '$childOutA');
          expect(await parentGuestProvider.isGuestScopeQuarantined(gCase1), isTrue);
          expect(await parentGuestProvider.isGuestScopePurged(gCase1), isFalse);
          expect(await localDao.hasGuestData('guest:$gCase1'), isTrue);
        } finally {
          readyA.close();
          resA.close();
          exitA.close();
        }

        // Subcase 2: Child Isolate.spawn holds purge lock -> Parent quarantine fails with GuestLifecycleStateError
        const gCase2 = 'g-t8a-purge-wins';
        await seedAllFourGuestLocalTables(gCase2);

        final readyB = ReceivePort();
        final heldB = ReceivePort();
        final resB = ReceivePort();
        final exitB = ReceivePort();

        try {
          await Isolate.spawn<_SingleOpWorkerConfig>(
            _singleOpWorkerEntry,
            _SingleOpWorkerConfig(
              dbPath: dbPath,
              guestProfileId: gCase2,
              operation: _WorkerOperation.purgeUnusedGuest,
              holdMs: 140,
              readyPort: readyB.sendPort,
              lockHeldPort: heldB.sendPort,
              resultPort: resB.sendPort,
            ),
            onExit: exitB.sendPort,
          );
          final cmdB = await readyB.first as SendPort;

          cmdB.send('go');
          await heldB.first;

          await expectLater(
            () => parentGuestProvider.quarantineGuestScope(
              gCase2,
              sourceUserId: userId,
            ),
            throwsA(isA<GuestLifecycleStateError>()),
          );
          final childOutB = (await resB.first)! as Map<Object?, Object?>;
          await exitB.first;

          expect(childOutB['status'], 'ok', reason: '$childOutB');
          expect(await parentGuestProvider.isGuestScopePurged(gCase2), isTrue);
          expect(await parentGuestProvider.isGuestScopeQuarantined(gCase2), isFalse);
          expect(await localDao.hasGuestData('guest:$gCase2'), isFalse);
        } finally {
          readyB.close();
          heldB.close();
          resB.close();
          exitB.close();
        }

        // Subcase 3: Child Isolate.spawn holds quarantine lock -> Parent purge fails with PurgeProhibitedError
        const gCase3 = 'g-t8a-child-quar-wins';
        await seedAllFourGuestLocalTables(gCase3);

        final readyC = ReceivePort();
        final heldC = ReceivePort();
        final resC = ReceivePort();
        final exitC = ReceivePort();

        try {
          await Isolate.spawn<_SingleOpWorkerConfig>(
            _singleOpWorkerEntry,
            _SingleOpWorkerConfig(
              dbPath: dbPath,
              guestProfileId: gCase3,
              operation: _WorkerOperation.quarantine,
              holdMs: 140,
              readyPort: readyC.sendPort,
              lockHeldPort: heldC.sendPort,
              resultPort: resC.sendPort,
            ),
            onExit: exitC.sendPort,
          );
          final cmdC = await readyC.first as SendPort;

          cmdC.send('go');
          await heldC.first;

          await expectLater(
            () => dal.purgeGuestLocalScope(
              guestScope: 'guest:$gCase3',
              reason: GuestLifecyclePurgeReason.verifiedUnusedGuestEviction,
              admission: testUnusedGuestAdmission(
                'guest:$gCase3',
                activeAccountUserId: userId,
              ),
              guestProfileProvider: parentGuestProvider,
            ),
            throwsA(isA<PurgeProhibitedError>()),
          );
          final childOutC = (await resC.first)! as Map<Object?, Object?>;
          await exitC.first;

          expect(childOutC['status'], 'ok', reason: '$childOutC');
          expect(
            await parentGuestProvider.isGuestScopeQuarantined(gCase3),
            isTrue,
          );
          expect(await parentGuestProvider.isGuestScopePurged(gCase3), isFalse);
          expect(await localDao.hasGuestData('guest:$gCase3'), isTrue);
        } finally {
          readyC.close();
          heldC.close();
          resC.close();
          exitC.close();
        }
      },
    );

    test(
      'T8b: 50-iteration concurrent stress race across 2 independent OS worker threads holds strict mutual exclusion on 50/50 rounds',
      () async {
        final readyQ = ReceivePort();
        final resultQ = ReceivePort();
        final exitQ = ReceivePort();
        final readyP = ReceivePort();
        final resultP = ReceivePort();
        final exitP = ReceivePort();

        SendPort? cmdQ;
        SendPort? cmdP;

        final qResultStream = StreamIterator<Object?>(resultQ);
        final pResultStream = StreamIterator<Object?>(resultP);

        try {
          await Isolate.spawn<_StressLoopWorkerConfig>(
            _stressLoopWorkerEntry,
            _StressLoopWorkerConfig(
              dbPath: dbPath,
              role: _StressRole.quarantine,
              readyPort: readyQ.sendPort,
              resultPort: resultQ.sendPort,
            ),
            onExit: exitQ.sendPort,
          );
          await Isolate.spawn<_StressLoopWorkerConfig>(
            _stressLoopWorkerEntry,
            _StressLoopWorkerConfig(
              dbPath: dbPath,
              role: _StressRole.purge,
              readyPort: readyP.sendPort,
              resultPort: resultP.sendPort,
            ),
            onExit: exitP.sendPort,
          );

          final rq = await readyQ.first;
          final rp = await readyP.first;
          if (rq is! SendPort || rp is! SendPort) {
            fail('Stress worker init failed: rq=$rq, rp=$rp');
          }
          cmdQ = rq;
          cmdP = rp;

          var quarantineWins = 0;
          var purgeWins = 0;

          for (var iter = 0; iter < 50; iter++) {
            final guestId = 'g-stress-$iter';
            final gScope = 'guest:$guestId';
            await seedAllFourGuestLocalTables(guestId);

            // Chuyển xen kẽ thứ tự kích phát & jitter để cả Quarantine lẫn Purge đều thắng tự nhiên
            final delayQMicros = iter.isEven ? 0 : 1200;
            final delayPMicros = iter.isEven ? 1200 : 0;

            cmdQ.send(<String, Object?>{
              'type': 'run',
              'guestProfileId': guestId,
              'delayMicros': delayQMicros,
            });
            cmdP.send(<String, Object?>{
              'type': 'run',
              'guestProfileId': guestId,
              'delayMicros': delayPMicros,
            });

            expect(await qResultStream.moveNext(), isTrue);
            expect(await pResultStream.moveNext(), isTrue);

            final outQ = qResultStream.current! as Map<Object?, Object?>;
            final outP = pResultStream.current! as Map<Object?, Object?>;

            final qOk = outQ['status'] == 'ok';
            final pOk = outP['status'] == 'ok';
            expect(
              qOk ^ pOk,
              isTrue,
              reason: 'Iter $iter must have exact mutual exclusion: outQ=$outQ, outP=$outP',
            );

            final qRows = await offlineDb.database.query(
              'guest_quarantined_scopes',
              where: 'guest_profile_id = ?',
              whereArgs: <Object?>[guestId],
            );
            final pRows = await offlineDb.database.query(
              'guest_purged_tombstones',
              where: 'guest_profile_id = ?',
              whereArgs: <Object?>[guestId],
            );
            final hasData = await localDao.hasGuestData(gScope);

            // Bất biến 1 & 2 trên MỌI vòng lặp:
            expect(
              qRows.isNotEmpty && !hasData,
              isFalse,
              reason: 'Iter $iter VIOLATION: quarantined guest lost data!',
            );
            expect(
              qRows.isNotEmpty && pRows.isNotEmpty,
              isFalse,
              reason: 'Iter $iter VIOLATION: both quarantine AND purge rows exist!',
            );

            if (qOk) {
              quarantineWins++;
              expect(qRows, hasLength(1));
              expect(pRows, isEmpty);
              expect(hasData, isTrue);
              expect(outP['isPurgeProhibited'], isTrue, reason: 'outP=$outP');
            } else {
              purgeWins++;
              expect(pRows, hasLength(1));
              expect(qRows, isEmpty);
              expect(hasData, isFalse);
              expect(outQ['isGuestLifecycleError'], isTrue, reason: 'outQ=$outQ');
            }
          }

          expect(quarantineWins, greaterThan(0));
          expect(purgeWins, greaterThan(0));
          expect(quarantineWins + purgeWins, 50);
        } finally {
          cmdQ?.send(<String, Object?>{'type': 'stop'});
          cmdP?.send(<String, Object?>{'type': 'stop'});
          await Future.wait(<Future<Object?>>[
            exitQ.first,
            exitP.first,
          ]).timeout(const Duration(seconds: 5), onTimeout: () => <Object?>[]);
          await qResultStream.cancel();
          await pResultStream.cancel();
          readyQ.close();
          resultQ.close();
          exitQ.close();
          readyP.close();
          resultP.close();
          exitP.close();
        }
      },
    );
  });

  group('Stage 1B T9: Claim Pre/Mid-HTTP Eligibility & Rebind CLAIMED_AND_REBOUND Tombstone', () {
    test(
      'T9a & T9b: checkAndPrepareClaim aborts pre-HTTP and mid-HTTP when Guest becomes PURGED or QUARANTINED without deadlocking login',
      () async {
        // 1. Pre-HTTP PURGED -> zero HTTP /prepare, resolves to account
        const gPrePurged = 'g-t9-pre-purged';
        SharedPreferences.setMockInitialValues(<String, Object>{
          GuestProfileIdentityProvider.keyGuestProfileId: gPrePurged,
          GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6: true,
        });
        prefs = await SharedPreferences.getInstance();
        final guestProvider = GuestProfileIdentityProvider(
          prefs: prefs,
          offlineDatabase: offlineDb,
        );
        await offlineDb.database.insert('guest_purged_tombstones', <String, Object?>{
          'guest_profile_id': gPrePurged,
          'purged_at_ms': 1000,
          'purge_reason': 'USER_CLEARED_GUEST_DATA',
        });

        final mockApi = _MockApiClient();
        final bridge = _FakeScopeClaimBridge();
        final authService = _FakeAuthService(
          AuthState.authenticated(
            user: const User(
              id: userId,
              username: 't9',
              email: 't9@omni.dev',
              role: 'READER',
            ),
            accessToken: 'tok',
          ),
        );
        final coordPrePurged = buildCoordinator(
          guestProvider: guestProvider,
          apiClient: mockApi,
          bridge: bridge,
          authService: authService,
        );
        await coordPrePurged.checkAndPrepareClaim(userId);
        verifyZeroInteractions(mockApi);
        expect(coordPrePurged.isOpen, isFalse);
        expect(coordPrePurged.error, contains('GUEST_ALREADY_PURGED'));
        expect(bridge.resolveCalls, hasLength(1));

        // 2. Pre-HTTP QUARANTINED -> zero HTTP /prepare, resolves to account
        const gPreQuar = 'g-t9-pre-quar';
        await prefs.setString(
          GuestProfileIdentityProvider.keyGuestProfileId,
          gPreQuar,
        );
        await seedAllFourGuestLocalTables(gPreQuar);
        await guestProvider.quarantineGuestScope(gPreQuar, sourceUserId: 'other');
        final coordPreQuar = buildCoordinator(
          guestProvider: guestProvider,
          apiClient: mockApi,
          bridge: bridge,
          authService: authService,
        );
        await coordPreQuar.checkAndPrepareClaim(userId);
        verifyZeroInteractions(mockApi);
        expect(coordPreQuar.isOpen, isFalse);
        expect(coordPreQuar.error, contains('GUEST_QUARANTINED'));
        expect(bridge.resolveCalls, hasLength(2));

        // 3. Mid-HTTP POST /prepare race -> PURGED before HTTP returns
        const gMidPurge = 'g-t9-mid-purge';
        await prefs.setString(
          GuestProfileIdentityProvider.keyGuestProfileId,
          gMidPurge,
        );
        await seedAllFourGuestLocalTables(gMidPurge);

        final httpStarted1 = Completer<void>();
        final httpRelease1 = Completer<void>();
        when(
          () => mockApi.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimPrepare,
            data: any<dynamic>(named: 'data'),
          ),
        ).thenAnswer((_) async {
          if (!httpStarted1.isCompleted) httpStarted1.complete();
          await httpRelease1.future;
          return Response<Map<String, dynamic>>(
            requestOptions: RequestOptions(path: ApiEndpoints.guestClaimPrepare),
            statusCode: 200,
            data: buildPreviewJson(claimId: 'claim-mid-purge'),
          );
        });

        final coordMidPurge = buildCoordinator(
          guestProvider: guestProvider,
          apiClient: mockApi,
          bridge: bridge,
          authService: authService,
        );
        final prepFuture1 = coordMidPurge.checkAndPrepareClaim(userId);
        await httpStarted1.future.timeout(const Duration(seconds: 5));

        // Xảy ra purge trong lúc HTTP /prepare đang bay trên mạng (SQLite không bị lock qua HTTP)
        await dal.purgeGuestLocalScope(
          guestScope: 'guest:$gMidPurge',
          reason: GuestLifecyclePurgeReason.userClearedGuestData,
          admission: testGuestAdmission('guest:$gMidPurge'),
          guestProfileProvider: guestProvider,
        );
        expect(
          await guestProvider.peekGuestProfileId(),
          isNot(equals(gMidPurge)),
        );
        httpRelease1.complete();
        await prepFuture1;

        expect(coordMidPurge.isOpen, isFalse);
        expect(coordMidPurge.error, contains('GUEST_ALREADY_PURGED'));
        expect(
          await offlineDb.database.query(
            'guest_claim_recovery_journal',
            where: 'claim_id = ?',
            whereArgs: <Object?>['claim-mid-purge'],
          ),
          isEmpty,
        );
        expect(bridge.resolveCalls, hasLength(3));

        // 4. Mid-HTTP POST /prepare race -> QUARANTINED before HTTP returns
        const gMidQuar = 'g-t9-mid-quar';
        await prefs.setString(
          GuestProfileIdentityProvider.keyGuestProfileId,
          gMidQuar,
        );
        final guestProviderStep4 = GuestProfileIdentityProvider(
          prefs: prefs,
          offlineDatabase: offlineDb,
        );
        await seedAllFourGuestLocalTables(gMidQuar);

        final httpStarted2 = Completer<void>();
        final httpRelease2 = Completer<void>();
        when(
          () => mockApi.post<Map<String, dynamic>>(
            ApiEndpoints.guestClaimPrepare,
            data: any<dynamic>(named: 'data'),
          ),
        ).thenAnswer((_) async {
          if (!httpStarted2.isCompleted) httpStarted2.complete();
          await httpRelease2.future;
          return Response<Map<String, dynamic>>(
            requestOptions: RequestOptions(path: ApiEndpoints.guestClaimPrepare),
            statusCode: 200,
            data: buildPreviewJson(claimId: 'claim-mid-quar'),
          );
        });

        final coordMidQuar = buildCoordinator(
          guestProvider: guestProviderStep4,
          apiClient: mockApi,
          bridge: bridge,
          authService: authService,
        );
        final prepFuture2 = coordMidQuar.checkAndPrepareClaim(userId);
        await httpStarted2.future.timeout(const Duration(seconds: 5));

        await guestProviderStep4.quarantineGuestScope(
          gMidQuar,
          sourceUserId: userId,
        );
        httpRelease2.complete();
        await prepFuture2;

        expect(coordMidQuar.isOpen, isFalse);
        expect(coordMidQuar.error, contains('GUEST_QUARANTINED'));
        expect(
          await offlineDb.database.query(
            'guest_claim_recovery_journal',
            where: 'claim_id = ?',
            whereArgs: <Object?>['claim-mid-quar'],
          ),
          isEmpty,
        );
        expect(bridge.resolveCalls, hasLength(4));
      },
    );

    test(
      'T9c: Crash recovery from committing -> GET /status COMMITTED writes CLAIMED_AND_REBOUND tombstone & locks out quarantine/skipClaim/re-prepare',
      () async {
        const gClaimed = 'g-t9-rebound';
        SharedPreferences.setMockInitialValues(<String, Object>{
          GuestProfileIdentityProvider.keyGuestProfileId: gClaimed,
          GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6: true,
        });
        prefs = await SharedPreferences.getInstance();
        final guestProvider = GuestProfileIdentityProvider(
          prefs: prefs,
          offlineDatabase: offlineDb,
        );
        await seedAllFourGuestLocalTables(gClaimed);

        // Seed journal đang kẹt ở pha 'committing' trước khi app restart
        await offlineDb.database.insert(
          'guest_claim_recovery_journal',
          <String, Object?>{
            'claim_id': testClaimId,
            'user_id': userId,
            'guest_profile_id': gClaimed,
            'expected_state_fingerprint': testFingerprint,
            'conflict_decisions': '{}',
            'phase': 'committing',
            'preview_data': jsonEncode(buildPreviewJson()),
            'created_at': 1000,
            'updated_at': 1000,
          },
        );

        final mockApi = _MockApiClient();
        final bridge = _FakeScopeClaimBridge();
        final authService = _FakeAuthService(
          AuthState.authenticated(
            user: const User(
              id: userId,
              username: 't9c',
              email: 't9c@omni.dev',
              role: 'READER',
            ),
            accessToken: 'tok',
          ),
        );

        when(
          () => mockApi.get<Map<String, dynamic>>(
            ApiEndpoints.guestClaimStatus(testClaimId),
          ),
        ).thenAnswer(
          (_) async => Response<Map<String, dynamic>>(
            requestOptions:
                RequestOptions(path: ApiEndpoints.guestClaimStatus(testClaimId)),
            statusCode: 200,
            data: <String, dynamic>{
              'claimId': testClaimId,
              'status': 'COMMITTED',
              'committedAt': '2026-11-09T12:00:00.000Z',
              'resultSummary': <String, dynamic>{
                'bookmarksImported': 1,
                'historyMerged': 1,
                'progressUpdated': 1,
                'conflictsResolved': 0,
              },
              'finalization': buildFinalizationJson(),
            },
          ),
        );

        final coord = buildCoordinator(
          guestProvider: guestProvider,
          apiClient: mockApi,
          bridge: bridge,
          authService: authService,
        );

        final recResult = await coord.checkCrashRecovery(userId);
        expect(recResult, CrashRecoveryResult.finalized);
        expect(bridge.resolveCalls, hasLength(1));

        // Dữ liệu đã chuyển sang account, guest partition + journal sạch, tombstone CLAIMED_AND_REBOUND bền vững
        expect(
          await localDao.isBookmarked(
            ownerScope: 'account:$userId',
            storyId: 'story-claim-1',
          ),
          isTrue,
        );
        expect(await localDao.hasGuestData('guest:$gClaimed'), isFalse);
        expect(
          await offlineDb.database.query('guest_claim_recovery_journal'),
          isEmpty,
        );

        final tombstoneRows = await offlineDb.database.query(
          'guest_purged_tombstones',
          where: 'guest_profile_id = ?',
          whereArgs: <Object?>[gClaimed],
        );
        expect(tombstoneRows, hasLength(1));
        expect(tombstoneRows.first['purge_reason'], 'CLAIMED_AND_REBOUND');
        expect(tombstoneRows.first['purged_by_user_id'], userId);

        // Terminal monotonic invariant: mọi thao tác quarantine / skipClaim / re-prepare lên gClaimed phải bị chặn
        await expectLater(
          () => guestProvider.quarantineGuestScope(gClaimed),
          throwsA(isA<GuestLifecycleStateError>()),
        );
        await expectLater(
          () => coord.skipClaim(userId),
          throwsA(isA<GuestLifecycleStateError>()),
        );

        reset(mockApi);
        await coord.checkAndPrepareClaim(userId);
        verifyZeroInteractions(mockApi);
        expect(coord.error, contains('GUEST_ALREADY_PURGED'));

        // Guard ngược lại trên rebindScope: không thể finalize claim nếu guest đã quarantined trong SQLite
        const gQuar = 'g-t9-rebind-blocked';
        await guestProvider.quarantineGuestScope(gQuar, sourceUserId: userId);
        await expectLater(
          () => localDao.rebindScope(
            sourceScope: 'guest:$gQuar',
            targetScope: 'account:$userId',
            claimId: 'claim-blocked',
            finalization: GuestClaimFinalizationData.fromJson(
              buildFinalizationJson(),
            ),
          ),
          throwsA(
            isA<StateError>().having(
              (e) => e.message,
              'message',
              contains('Cannot purge and finalize claim for quarantined guest'),
            ),
          ),
        );
      },
    );
  });
}

enum _WorkerOperation { purgeUnusedGuest, quarantine }

class _SingleOpWorkerConfig {
  final String dbPath;
  final String guestProfileId;
  final _WorkerOperation operation;
  final int holdMs;
  final SendPort readyPort;
  final SendPort? lockHeldPort;
  final SendPort resultPort;

  const _SingleOpWorkerConfig({
    required this.dbPath,
    required this.guestProfileId,
    required this.operation,
    required this.holdMs,
    required this.readyPort,
    required this.lockHeldPort,
    required this.resultPort,
  });
}

Future<void> _singleOpWorkerEntry(_SingleOpWorkerConfig config) async {
  sqfliteFfiInit();
  final commandPort = ReceivePort();
  final db = OfflineDatabase();
  var sentReady = false;
  Map<String, Object?>? payload;

  try {
    await db.initialize(
      customPath: config.dbPath,
      databaseFactory: databaseFactoryFfiNoIsolate,
      singleInstance: false,
    );
    config.readyPort.send(commandPort.sendPort);
    sentReady = true;

    await commandPort.first;

    final purePrefs = _PureDartSharedPrefs(<String, Object>{
      GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6: true,
    });
    final guestProvider = GuestProfileIdentityProvider(
      prefs: purePrefs,
      offlineDatabase: db,
    );
    final dal = SyncStorageDal(offlineDatabase: db);

    if (config.operation == _WorkerOperation.purgeUnusedGuest) {
      final scope = 'guest:${config.guestProfileId}';
      await dal.purgeGuestLocalScope(
        guestScope: scope,
        reason: GuestLifecyclePurgeReason.verifiedUnusedGuestEviction,
        admission: testUnusedGuestAdmission(
          scope,
          activeAccountUserId: 'worker-acc',
        ),
        guestProfileProvider: guestProvider,
        onBeforeCommitHook: (_) async {
          config.lockHeldPort?.send(null);
          if (config.holdMs > 0) {
            await Future<void>.delayed(Duration(milliseconds: config.holdMs));
          }
        },
      );
    } else {
      await guestProvider.quarantineGuestScope(
        config.guestProfileId,
        sourceUserId: 'worker-acc',
        onBeforeCommitHook: (_) async {
          config.lockHeldPort?.send(null);
          if (config.holdMs > 0) {
            await Future<void>.delayed(Duration(milliseconds: config.holdMs));
          }
        },
      );
    }

    payload = <String, Object?>{'status': 'ok'};
  } catch (e) {
    if (!sentReady) {
      config.readyPort.send(<String, Object?>{'initError': e.toString()});
    } else {
      payload = <String, Object?>{
        'status': 'error',
        'isPurgeProhibited': e is PurgeProhibitedError,
        'isGuestLifecycleError': e is GuestLifecycleStateError,
        'errorType': e.runtimeType.toString(),
        'message': e.toString(),
      };
    }
  } finally {
    commandPort.close();
    if (db.isInitialized) {
      await db.close();
    }
    if (payload != null) {
      config.resultPort.send(payload);
    }
  }
}

enum _StressRole { quarantine, purge }

class _StressLoopWorkerConfig {
  final String dbPath;
  final _StressRole role;
  final SendPort readyPort;
  final SendPort resultPort;

  const _StressLoopWorkerConfig({
    required this.dbPath,
    required this.role,
    required this.readyPort,
    required this.resultPort,
  });
}

Future<void> _stressLoopWorkerEntry(_StressLoopWorkerConfig config) async {
  sqfliteFfiInit();
  final commandPort = ReceivePort();
  final db = OfflineDatabase();
  var sentReady = false;

  try {
    await db.initialize(
      customPath: config.dbPath,
      databaseFactory: databaseFactoryFfiNoIsolate,
      singleInstance: false,
    );
    config.readyPort.send(commandPort.sendPort);
    sentReady = true;

    final purePrefs = _PureDartSharedPrefs(<String, Object>{
      GuestProfileIdentityProvider.keyQuarantinedProfilesMigratedV6: true,
    });
    final guestProvider = GuestProfileIdentityProvider(
      prefs: purePrefs,
      offlineDatabase: db,
    );
    final dal = SyncStorageDal(offlineDatabase: db);

    await for (final msg in commandPort) {
      final map = msg as Map<Object?, Object?>;
      if (map['type'] == 'stop') {
        break;
      }
      final guestId = map['guestProfileId']! as String;
      final delayMicros = (map['delayMicros'] as int?) ?? 0;
      if (delayMicros > 0) {
        await Future<void>.delayed(Duration(microseconds: delayMicros));
      }

      try {
        if (config.role == _StressRole.quarantine) {
          await guestProvider.quarantineGuestScope(
            guestId,
            sourceUserId: 'stress-user',
          );
        } else {
          final gScope = 'guest:$guestId';
          await dal.purgeGuestLocalScope(
            guestScope: gScope,
            reason: GuestLifecyclePurgeReason.verifiedUnusedGuestEviction,
            admission: testUnusedGuestAdmission(
              gScope,
              activeAccountUserId: 'stress-user',
            ),
            guestProfileProvider: guestProvider,
          );
        }
        config.resultPort.send(<String, Object?>{'status': 'ok'});
      } catch (e) {
        config.resultPort.send(<String, Object?>{
          'status': 'error',
          'isPurgeProhibited': e is PurgeProhibitedError,
          'isGuestLifecycleError': e is GuestLifecycleStateError,
          'errorType': e.runtimeType.toString(),
          'message': e.toString(),
        });
      }
    }
  } catch (e) {
    if (!sentReady) {
      config.readyPort.send(<String, Object?>{'initError': e.toString()});
    } else {
      config.resultPort.send(<String, Object?>{
        'status': 'fatal',
        'message': e.toString(),
      });
    }
  } finally {
    commandPort.close();
    if (db.isInitialized) {
      await db.close();
    }
  }
}
