import 'dart:io';
import 'dart:isolate';

import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/core/sync/errors/sync_storage_exceptions.dart';
import 'package:omninovel_mobile/core/sync/models/sync_models.dart';
import 'package:omninovel_mobile/core/sync/storage/sync_storage_dal.dart';
import 'package:omninovel_mobile/core/sync/utils/canonical_entity_key.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  late Directory tempDir;
  late String dbPath;
  late OfflineDatabase offlineDb;
  late SyncStorageDal dal;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('omninovel_sync_delta_test_');
    dbPath = p.join(tempDir.path, 'sync_delta_test.db');
    offlineDb = OfflineDatabase();
    await offlineDb.initialize(
      customPath: dbPath,
      databaseFactory: databaseFactoryFfi,
      singleInstance: false,
    );
    dal = SyncStorageDal(offlineDatabase: offlineDb);
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

  group('Atomic Delta Ingestion & P0-M01 Cursor Integrity', () {
    test('atomically ingests all 5 domains, advances checkpoint, and keeps baseline UNINITIALIZED', () async {
      const scope = 'account:delta-1';
      final page = SyncChangesPage(
        currentServerRevision: '105',
        minActiveRevision: '0',
        nextRevision: null,
        hasMore: false,
        changes: <SyncChangeItem>[
          SyncChangeItem.typed(
            revision: '101',
            domain: SyncDomain.bookmark,
            entityId: 'story-1',
            operation: SyncOperation.upsert,
            payload: const <String, Object?>{'storyId': 'story-1', 'title': 'Story One'},
          ),
          SyncChangeItem.typed(
            revision: '102',
            domain: SyncDomain.progress,
            entityId: 'story-1',
            operation: SyncOperation.upsert,
            payload: const <String, Object?>{'storyId': 'story-1', 'chapterId': 'ch-1', 'observedHistoryEpoch': 1},
          ),
          SyncChangeItem.typed(
            revision: '103',
            domain: SyncDomain.history,
            entityId: 'story-1:ch-1',
            operation: SyncOperation.upsert,
            payload: const <String, Object?>{'storyId': 'story-1', 'chapterId': 'ch-1', 'maxProgressPercentage': 85, 'observedHistoryEpoch': 1},
          ),
          SyncChangeItem.typed(
            revision: '104',
            domain: SyncDomain.preference,
            entityId: 'theme',
            operation: SyncOperation.upsert,
            payload: const <String, Object?>{'key': 'theme', 'value': 'dark'},
          ),
          SyncChangeItem.typed(
            revision: '105',
            domain: SyncDomain.follow,
            entityId: 'author-9',
            operation: SyncOperation.upsert,
            payload: const <String, Object?>{'authorId': 'author-9'},
          ),
        ],
      );

      final result = await dal.applyAuthoritativeDeltaPage(
        ownerScope: scope,
        expectedCheckpoint: '0',
        page: page,
      );

      expect(result.appliedCount, 5);
      expect(result.newCheckpoint, '105');
      expect(result.hasMore, isFalse);

      expect((await dal.getAuthoritativeShadow(scope, SyncDomain.bookmark, 'story-1'))?.serverRevision, '101');
      expect((await dal.getAuthoritativeShadow(scope, SyncDomain.progress, 'story-1'))?.epoch, 1);
      expect((await dal.getAuthoritativeShadow(scope, SyncDomain.history, 'story-1:ch-1'))?.serverRevision, '103');
      expect((await dal.getAuthoritativeShadow(scope, SyncDomain.preference, 'theme'))?.payload?['value'], 'dark');
      expect((await dal.getAuthoritativeShadow(scope, SyncDomain.follow, 'author-9'))?.serverRevision, '105');

      final meta = await dal.getSyncMeta(scope);
      expect(meta?.lastSyncedServerRevision, '105');
      expect(meta?.authoritativeBaselineStatus, AuthoritativeBaselineStatus.uninitialized);
      expect(await dal.isAuthoritativeReady(scope), isFalse);
    });

    test('supports 64-bit BIGINT revisions > Number.MAX_SAFE_INTEGER and rejects overflow > 2^63 - 1', () async {
      const scope = 'account:bigint-delta';
      const bigBase = '9007199254740995'; // > 2^53 - 1
      const bigNext = '9007199254740999';

      await dal.putSyncMeta(
        const SyncMeta(
          ownerScope: scope,
          lastSyncedServerRevision: bigBase,
          minActiveRevision: '9007199254740990',
          lastSyncTimestamp: '2026-01-01T00:00:00.000Z',
        ),
      );

      final res = await dal.applyAuthoritativeDeltaPage(
        ownerScope: scope,
        expectedCheckpoint: bigBase,
        page: SyncChangesPage(
          currentServerRevision: bigNext,
          minActiveRevision: '9007199254740990',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '9007199254740997',
              domain: SyncDomain.bookmark,
              entityId: 'story-big',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'storyId': 'story-big'},
            ),
          ],
        ),
      );
      expect(res.newCheckpoint, bigNext);

      // Exceeds signed 64-bit BIGINT max ('9223372036854775808') -> must reject
      await expectLater(
        () => dal.applyAuthoritativeDeltaPage(
          ownerScope: scope,
          expectedCheckpoint: bigNext,
          page: const SyncChangesPage(
            currentServerRevision: '9223372036854775808',
            minActiveRevision: '0',
            nextRevision: null,
            hasMore: false,
            changes: <SyncChangeItem>[],
          ),
        ),
        throwsA(isA<InvalidDeltaPayloadError>()),
      );
    });

    test('P0-M01 rejects invalid checkpoints, inconsistent cursors, compaction gap, bounds, ordering, and rolls back cleanly', () async {
      const scope = 'account:p0-m01';

      // Seed valid initial checkpoint '50'
      await dal.applyAuthoritativeDeltaPage(
        ownerScope: scope,
        expectedCheckpoint: '0',
        page: SyncChangesPage(
          currentServerRevision: '50',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '50',
              domain: SyncDomain.bookmark,
              entityId: 'story-seed',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'storyId': 'story-seed'},
            ),
          ],
        ),
      );

      Future<void> expectRejected(
        String? expectedCkpt,
        SyncChangesPage page,
        Pattern messagePattern,
      ) async {
        await expectLater(
          () => dal.applyAuthoritativeDeltaPage(
            ownerScope: scope,
            expectedCheckpoint: expectedCkpt,
            page: page,
          ),
          throwsA(
            isA<InvalidDeltaPayloadError>().having(
              (e) => e.message,
              'message',
              matches(messagePattern),
            ),
          ),
        );
      }

      // 1. Missing / malformed expectedCheckpoint
      await expectRejected(
        null,
        const SyncChangesPage(
          currentServerRevision: '60',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[],
        ),
        'MANDATORY_OCC_CHECKPOINT_REQUIRED',
      );
      await expectRejected(
        '01', // Leading zero non-canonical
        const SyncChangesPage(
          currentServerRevision: '60',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[],
        ),
        'MANDATORY_OCC_CHECKPOINT_REQUIRED',
      );

      // 2. hasMore == true with empty changes
      await expectRejected(
        '50',
        const SyncChangesPage(
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: '60',
          hasMore: true,
          changes: <SyncChangeItem>[],
        ),
        'changes array is empty',
      );

      // 3. hasMore == true with nextRevision != changes.last.revision
      await expectRejected(
        '50',
        SyncChangesPage(
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: '90',
          hasMore: true,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '70',
              domain: SyncDomain.bookmark,
              entityId: 'story-bad-cursor',
              operation: SyncOperation.upsert,
            ),
          ],
        ),
        'does not match last change revision',
      );

      // 4. hasMore == false with non-null nextRevision
      await expectRejected(
        '50',
        const SyncChangesPage(
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: '100',
          hasMore: false,
          changes: <SyncChangeItem>[],
        ),
        'hasMore is false, but nextRevision is not null',
      );

      // 5. Compacted retention gap (expectedCheckpoint 50 < minActiveRevision 80)
      await expectRejected(
        '50',
        const SyncChangesPage(
          currentServerRevision: '100',
          minActiveRevision: '80',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[],
        ),
        'COMPACTED_RETENTION_GAP',
      );

      // 6. targetCheckpoint exceeds currentServerRevision
      await expectRejected(
        '50',
        SyncChangesPage(
          currentServerRevision: '90',
          minActiveRevision: '0',
          nextRevision: '95',
          hasMore: true,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '95',
              domain: SyncDomain.bookmark,
              entityId: 'story-x',
              operation: SyncOperation.upsert,
            ),
          ],
        ),
        'exceeds currentServerRevision',
      );

      // 7. Regressive targetCheckpoint (< expectedCheckpoint)
      await expectRejected(
        '50',
        const SyncChangesPage(
          currentServerRevision: '40',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[],
        ),
        'REGRESSIVE_CHECKPOINT',
      );

      // 8. Change revision <= expectedCheckpoint or regressive within page
      await expectRejected(
        '50',
        SyncChangesPage(
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '50',
              domain: SyncDomain.bookmark,
              entityId: 'story-dup',
              operation: SyncOperation.upsert,
            ),
          ],
        ),
        '<= expectedCheckpoint',
      );

      await expectRejected(
        '50',
        SyncChangesPage(
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '80',
              domain: SyncDomain.bookmark,
              entityId: 's1',
              operation: SyncOperation.upsert,
            ),
            SyncChangeItem.typed(
              revision: '70', // Regressive!
              domain: SyncDomain.bookmark,
              entityId: 's2',
              operation: SyncOperation.upsert,
            ),
          ],
        ),
        'regressive revision',
      );

      // 9. Unsupported domain / operation
      await expectRejected(
        '50',
        const SyncChangesPage(
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem(
              revision: '60',
              domain: 'UNKNOWN_DOMAIN',
              entityId: 's1',
              operation: 'UPSERT',
            ),
          ],
        ),
        'unsupported domain',
      );

      await expectRejected(
        '50',
        const SyncChangesPage(
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem(
              revision: '60',
              domain: 'BOOKMARK',
              entityId: 's1',
              operation: 'PATCH',
            ),
          ],
        ),
        'unsupported operation',
      );

      // 10. HISTORY DELETE missing epoch
      await expectRejected(
        '50',
        SyncChangesPage(
          currentServerRevision: '100',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '60',
              domain: SyncDomain.history,
              entityId: 'story-1',
              operation: SyncOperation.delete,
              payload: const <String, Object?>{},
            ),
          ],
        ),
        'MISSING_HISTORY_DELETE_EPOCH',
      );

      // Verify state remains untouched at checkpoint '50'
      expect((await dal.getSyncMeta(scope))?.lastSyncedServerRevision, '50');
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.bookmark, 'story-seed'), isNotNull);
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.bookmark, 'story-bad-cursor'), isNull);
    });
  });

  group('P0-M02 Native SQLite OCC & Dual-Connection Contention', () {
    test('single connection OCC conflict throws CheckpointConflictError with zero dirty shadow', () async {
      const scope = 'account:occ-single';
      await dal.putSyncMeta(
        const SyncMeta(
          ownerScope: scope,
          lastSyncedServerRevision: '100',
          minActiveRevision: '50',
          lastSyncTimestamp: '2026-01-01T00:00:00.000Z',
        ),
      );

      await expectLater(
        () => dal.applyAuthoritativeDeltaPage(
          ownerScope: scope,
          expectedCheckpoint: '90',
          page: SyncChangesPage(
            currentServerRevision: '110',
            minActiveRevision: '50',
            nextRevision: null,
            hasMore: false,
            changes: <SyncChangeItem>[
              SyncChangeItem.typed(
                revision: '105',
                domain: SyncDomain.bookmark,
                entityId: 'story-dirty',
                operation: SyncOperation.upsert,
              ),
            ],
          ),
        ),
        throwsA(isA<CheckpointConflictError>()),
      );

      expect((await dal.getSyncMeta(scope))?.lastSyncedServerRevision, '100');
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.bookmark, 'story-dirty'), isNull);
    });

    test('two independent OfflineDatabase SQLite connections racing concurrently yield 1 winner and 1 CheckpointConflictError', () async {
      const scope = 'account:occ-dual-race';

      await dal.putSyncMeta(
        const SyncMeta(
          ownerScope: scope,
          lastSyncedServerRevision: '100',
          minActiveRevision: '0',
          lastSyncTimestamp: '2026-01-01T00:00:00.000Z',
        ),
      );

      final readyPort1 = ReceivePort();
      final readyPort2 = ReceivePort();
      final resultPort1 = ReceivePort();
      final resultPort2 = ReceivePort();
      final exitPort1 = ReceivePort();
      final exitPort2 = ReceivePort();

      try {
        await Isolate.spawn<_ConcurrentDeltaWorkerConfig>(
          _concurrentDeltaWorkerEntry,
          _ConcurrentDeltaWorkerConfig(
            dbPath: dbPath,
            ownerScope: scope,
            expectedCheckpoint: '100',
            currentServerRevision: '120',
            nextRevision: '105',
            hasMore: true,
            changeRevision: '105',
            entityId: 'story-conn1',
            title: 'Conn 1',
            readyPort: readyPort1.sendPort,
            resultPort: resultPort1.sendPort,
          ),
          onExit: exitPort1.sendPort,
        );

        await Isolate.spawn<_ConcurrentDeltaWorkerConfig>(
          _concurrentDeltaWorkerEntry,
          _ConcurrentDeltaWorkerConfig(
            dbPath: dbPath,
            ownerScope: scope,
            expectedCheckpoint: '100',
            currentServerRevision: '120',
            nextRevision: null,
            hasMore: false,
            changeRevision: '115',
            entityId: 'story-conn2',
            title: 'Conn 2',
            readyPort: readyPort2.sendPort,
            resultPort: resultPort2.sendPort,
          ),
          onExit: exitPort2.sendPort,
        );

        final readyMsg1 = await readyPort1.first;
        final readyMsg2 = await readyPort2.first;
        if (readyMsg1 is! SendPort) {
          fail('Worker 1 failed to initialize SQLite connection: $readyMsg1');
        }
        if (readyMsg2 is! SendPort) {
          fail('Worker 2 failed to initialize SQLite connection: $readyMsg2');
        }

        // Hai OS thread độc lập xuất phát cùng lúc tranh chấp checkpoint '100'
        readyMsg1.send('go');
        readyMsg2.send('go');

        final results = await Future.wait<Object?>(<Future<Object?>>[
          resultPort1.first,
          resultPort2.first,
        ]);
        await Future.wait<Object?>(<Future<Object?>>[
          exitPort1.first,
          exitPort2.first,
        ]);

        final r1 = results[0]! as Map<Object?, Object?>;
        final r2 = results[1]! as Map<Object?, Object?>;

        final okCount = (r1['status'] == 'ok' ? 1 : 0) + (r2['status'] == 'ok' ? 1 : 0);
        final errResults = <Map<Object?, Object?>>[
          if (r1['status'] != 'ok') r1,
          if (r2['status'] != 'ok') r2,
        ];

        expect(okCount, 1, reason: 'r1=$r1, r2=$r2');
        expect(errResults, hasLength(1), reason: 'r1=$r1, r2=$r2');
        expect(errResults.first['isCheckpointConflict'], isTrue, reason: 'err=${errResults.first}');

        final shadow1 = await dal.getAuthoritativeShadow(scope, SyncDomain.bookmark, 'story-conn1');
        final shadow2 = await dal.getAuthoritativeShadow(scope, SyncDomain.bookmark, 'story-conn2');
        final meta = await dal.getSyncMeta(scope);

        if (r1['status'] == 'ok') {
          expect(shadow1, isNotNull);
          expect(shadow2, isNull);
          expect(meta?.lastSyncedServerRevision, '105');
        } else {
          expect(shadow2, isNotNull);
          expect(shadow1, isNull);
          expect(meta?.lastSyncedServerRevision, '120');
        }
      } finally {
        readyPort1.close();
        readyPort2.close();
        resultPort1.close();
        resultPort2.close();
        exitPort1.close();
        exitPort2.close();
      }
    });

    test('interleaved independent SQLite connection waits on busy_timeout during held write lock and aborts via native OCC', () async {
      const scope = 'account:occ-interleaved';

      await dal.putSyncMeta(
        const SyncMeta(
          ownerScope: scope,
          lastSyncedServerRevision: '50',
          minActiveRevision: '0',
          lastSyncTimestamp: '2026-01-01T00:00:00.000Z',
        ),
      );

      final readyPortA = ReceivePort();
      final readyPortB = ReceivePort();
      final lockHeldPortA = ReceivePort();
      final resultPortA = ReceivePort();
      final resultPortB = ReceivePort();
      final exitPortA = ReceivePort();
      final exitPortB = ReceivePort();

      try {
        await Isolate.spawn<_InterleavedWinnerWorkerConfig>(
          _interleavedWinnerWorkerEntry,
          _InterleavedWinnerWorkerConfig(
            dbPath: dbPath,
            ownerScope: scope,
            readyPort: readyPortA.sendPort,
            lockHeldPort: lockHeldPortA.sendPort,
            resultPort: resultPortA.sendPort,
          ),
          onExit: exitPortA.sendPort,
        );
        final cmdA = await readyPortA.first;
        if (cmdA is! SendPort) {
          fail('Worker A failed to initialize SQLite connection: $cmdA');
        }

        await Isolate.spawn<_ConcurrentDeltaWorkerConfig>(
          _concurrentDeltaWorkerEntry,
          _ConcurrentDeltaWorkerConfig(
            dbPath: dbPath,
            ownerScope: scope,
            expectedCheckpoint: '50',
            currentServerRevision: '100',
            nextRevision: null,
            hasMore: false,
            changeRevision: '80',
            entityId: 'story-loser-B',
            title: 'Loser B',
            readyPort: readyPortB.sendPort,
            resultPort: resultPortB.sendPort,
          ),
          onExit: exitPortB.sendPort,
        );
        final cmdB = await readyPortB.first;
        if (cmdB is! SendPort) {
          fail('Worker B failed to initialize SQLite connection: $cmdB');
        }

        // Bắt đầu Worker A trên OS Thread A
        cmdA.send('go');
        // Đợi cho tới khi Worker A thực sự giữ khóa ghi WAL/BEGIN IMMEDIATE trước khi commit
        await lockHeldPortA.first;
        // Phát động Worker B với stale checkpoint '50' trong lúc A đang giữ khóa ghi 150ms -> ép native SQLite busy_timeout + OCC
        cmdB.send('go');

        final results = await Future.wait<Object?>(<Future<Object?>>[
          resultPortA.first,
          resultPortB.first,
        ]);
        await Future.wait<Object?>(<Future<Object?>>[
          exitPortA.first,
          exitPortB.first,
        ]);

        final resA = results[0]! as Map<Object?, Object?>;
        final resB = results[1]! as Map<Object?, Object?>;

        expect(resA['status'], 'ok', reason: 'resA=$resA');
        expect(resA['newCheckpoint'], '70');
        expect(resB['status'], 'error', reason: 'resB=$resB');
        expect(resB['isCheckpointConflict'], isTrue, reason: 'resB=$resB');

        expect(await dal.getAuthoritativeShadow(scope, SyncDomain.bookmark, 'story-winner-A'), isNotNull);
        expect(await dal.getAuthoritativeShadow(scope, SyncDomain.bookmark, 'story-loser-B'), isNull);
        expect((await dal.getSyncMeta(scope))?.lastSyncedServerRevision, '70');
      } finally {
        readyPortA.close();
        readyPortB.close();
        lockHeldPortA.close();
        resultPortA.close();
        resultPortB.close();
        exitPortA.close();
        exitPortB.close();
      }
    });
  });

  group('HISTORY DELETE Tombstones, Epochs & SQL LIKE Wildcard Isolation', () {
    test('story-wide HISTORY DELETE cascades shadows, preserves other stories & bookmarks, and escapes SQL LIKE wildcards (_ / %)', () async {
      const scope = 'account:history-like';

      await dal.applyAuthoritativeDeltaPage(
        ownerScope: scope,
        expectedCheckpoint: '0',
        page: SyncChangesPage(
          currentServerRevision: '10',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '1',
              domain: SyncDomain.bookmark,
              entityId: 'story_1',
              operation: SyncOperation.upsert,
            ),
            SyncChangeItem.typed(
              revision: '2',
              domain: SyncDomain.history,
              entityId: 'story_1:ch-1',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'storyId': 'story_1', 'chapterId': 'ch-1'},
            ),
            SyncChangeItem.typed(
              revision: '3',
              domain: SyncDomain.progress,
              entityId: 'story_1',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'storyId': 'story_1'},
            ),
            // Wildcard traps: 'story-1' and 'storyA1' must NOT match escaped 'story\_1:%'!
            SyncChangeItem.typed(
              revision: '4',
              domain: SyncDomain.history,
              entityId: 'story-1:ch-1',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'storyId': 'story-1', 'chapterId': 'ch-1'},
            ),
            SyncChangeItem.typed(
              revision: '5',
              domain: SyncDomain.history,
              entityId: 'storyA1:ch-1',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'storyId': 'storyA1', 'chapterId': 'ch-1'},
            ),
            SyncChangeItem.typed(
              revision: '6',
              domain: SyncDomain.history,
              entityId: 'story%1:ch-1',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'storyId': 'story%1', 'chapterId': 'ch-1'},
            ),
            SyncChangeItem.typed(
              revision: '7',
              domain: SyncDomain.history,
              entityId: 'storyANY1:ch-1',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'storyId': 'storyANY1', 'chapterId': 'ch-1'},
            ),
          ],
        ),
      );

      // Delete story_1 with epoch 2
      final res1 = await dal.applyAuthoritativeDeltaPage(
        ownerScope: scope,
        expectedCheckpoint: '10',
        page: SyncChangesPage(
          currentServerRevision: '11',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '11',
              domain: SyncDomain.history,
              entityId: 'story_1',
              operation: SyncOperation.delete,
              payload: const <String, Object?>{'storyId': 'story_1', 'epoch': 2},
            ),
          ],
        ),
      );
      expect(res1.effectiveEpochs['story_1'], 2);
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.history, 'story_1:ch-1'), isNull);
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.progress, 'story_1'), isNull);
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.bookmark, 'story_1'), isNotNull);
      // Wildcard neighbors MUST remain intact
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.history, 'story-1:ch-1'), isNotNull);
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.history, 'storyA1:ch-1'), isNotNull);

      // Delete story%1 with epoch 3 -> storyANY1 must stay intact
      await dal.applyAuthoritativeDeltaPage(
        ownerScope: scope,
        expectedCheckpoint: '11',
        page: SyncChangesPage(
          currentServerRevision: '12',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '12',
              domain: SyncDomain.history,
              entityId: 'story%1',
              operation: SyncOperation.delete,
              payload: const <String, Object?>{'storyId': 'story%1', 'epoch': 3},
            ),
          ],
        ),
      );
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.history, 'story%1:ch-1'), isNull);
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.history, 'storyANY1:ch-1'), isNotNull);
    });

    test('global HISTORY DELETE clears all HISTORY & PROGRESS preserving BOOKMARK/PREFERENCE and enforces epoch dominance', () async {
      const scope = 'account:history-global';

      await dal.applyAuthoritativeDeltaPage(
        ownerScope: scope,
        expectedCheckpoint: '0',
        page: SyncChangesPage(
          currentServerRevision: '20',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '10',
              domain: SyncDomain.bookmark,
              entityId: 's-keep',
              operation: SyncOperation.upsert,
            ),
            SyncChangeItem.typed(
              revision: '11',
              domain: SyncDomain.preference,
              entityId: 'lang',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'key': 'lang', 'value': 'vi'},
            ),
            SyncChangeItem.typed(
              revision: '12',
              domain: SyncDomain.history,
              entityId: 's1:c1',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'storyId': 's1', 'chapterId': 'c1'},
            ),
            SyncChangeItem.typed(
              revision: '13',
              domain: SyncDomain.progress,
              entityId: 's1',
              operation: SyncOperation.upsert,
              payload: const <String, Object?>{'storyId': 's1'},
            ),
          ],
        ),
      );

      // Global delete at epoch 5
      final globalRes = await dal.applyAuthoritativeDeltaPage(
        ownerScope: scope,
        expectedCheckpoint: '20',
        page: SyncChangesPage(
          currentServerRevision: '25',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '25',
              domain: SyncDomain.history,
              entityId: kGlobalHistorySentinelUuid,
              operation: SyncOperation.delete,
              payload: const <String, Object?>{'epoch': 5},
            ),
          ],
        ),
      );

      expect(globalRes.effectiveEpochs[kGlobalHistorySentinelUuid], 5);
      expect(getEffectiveHistoryEpoch(globalRes.effectiveEpochs, 'brand-new-story'), 5);
      expect(await dal.getAuthoritativeShadowsByDomain(scope, SyncDomain.history), isEmpty);
      expect(await dal.getAuthoritativeShadowsByDomain(scope, SyncDomain.progress), isEmpty);
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.bookmark, 's-keep'), isNotNull);
      expect(await dal.getAuthoritativeShadow(scope, SyncDomain.preference, 'lang'), isNotNull);

      // Global epoch dominance: story epoch 4 (even though storyEpoch was 0) is <= globalEpoch 5 -> MUST FAIL
      await expectLater(
        () => dal.applyAuthoritativeDeltaPage(
          ownerScope: scope,
          expectedCheckpoint: '25',
          page: SyncChangesPage(
            currentServerRevision: '30',
            minActiveRevision: '0',
            nextRevision: null,
            hasMore: false,
            changes: <SyncChangeItem>[
              SyncChangeItem.typed(
                revision: '30',
                domain: SyncDomain.history,
                entityId: 'story-dominant-check',
                operation: SyncOperation.delete,
                payload: const <String, Object?>{'storyId': 'story-dominant-check', 'epoch': 4},
              ),
            ],
          ),
        ),
        throwsA(isA<NonMonotonicHistoryEpochError>()),
      );

      // Stale global epoch 5 ('all' alias) -> MUST FAIL
      await expectLater(
        () => dal.applyAuthoritativeDeltaPage(
          ownerScope: scope,
          expectedCheckpoint: '25',
          page: SyncChangesPage(
            currentServerRevision: '31',
            minActiveRevision: '0',
            nextRevision: null,
            hasMore: false,
            changes: <SyncChangeItem>[
              SyncChangeItem.typed(
                revision: '31',
                domain: SyncDomain.history,
                entityId: 'all',
                operation: SyncOperation.delete,
                payload: const <String, Object?>{'epoch': 5},
              ),
            ],
          ),
        ),
        throwsA(isA<NonMonotonicHistoryEpochError>()),
      );

      // Global epoch 6 via 'all' succeeds
      final globalRes2 = await dal.applyAuthoritativeDeltaPage(
        ownerScope: scope,
        expectedCheckpoint: '25',
        page: SyncChangesPage(
          currentServerRevision: '35',
          minActiveRevision: '0',
          nextRevision: null,
          hasMore: false,
          changes: <SyncChangeItem>[
            SyncChangeItem.typed(
              revision: '35',
              domain: SyncDomain.history,
              entityId: 'all',
              operation: SyncOperation.delete,
              payload: const <String, Object?>{'epoch': 6},
            ),
          ],
        ),
      );
      expect(globalRes2.effectiveEpochs[kGlobalHistorySentinelUuid], 6);

      // Checkpoint remains clean across previous rejections
      expect((await dal.getSyncMeta(scope))?.lastSyncedServerRevision, '35');
    });
  });
}

class _ConcurrentDeltaWorkerConfig {
  final String dbPath;
  final String ownerScope;
  final String expectedCheckpoint;
  final String currentServerRevision;
  final String? nextRevision;
  final bool hasMore;
  final String changeRevision;
  final String entityId;
  final String title;
  final SendPort readyPort;
  final SendPort resultPort;

  const _ConcurrentDeltaWorkerConfig({
    required this.dbPath,
    required this.ownerScope,
    required this.expectedCheckpoint,
    required this.currentServerRevision,
    required this.nextRevision,
    required this.hasMore,
    required this.changeRevision,
    required this.entityId,
    required this.title,
    required this.readyPort,
    required this.resultPort,
  });
}

class _InterleavedWinnerWorkerConfig {
  final String dbPath;
  final String ownerScope;
  final SendPort readyPort;
  final SendPort lockHeldPort;
  final SendPort resultPort;

  const _InterleavedWinnerWorkerConfig({
    required this.dbPath,
    required this.ownerScope,
    required this.readyPort,
    required this.lockHeldPort,
    required this.resultPort,
  });
}

Future<void> _concurrentDeltaWorkerEntry(
  _ConcurrentDeltaWorkerConfig config,
) async {
  sqfliteFfiInit();
  final commandPort = ReceivePort();
  final db = OfflineDatabase();
  var sentReady = false;
  Map<String, Object?>? resultPayload;

  try {
    await db.initialize(
      customPath: config.dbPath,
      databaseFactory: databaseFactoryFfiNoIsolate,
      singleInstance: false,
    );
    config.readyPort.send(commandPort.sendPort);
    sentReady = true;

    await commandPort.first;

    final dal = SyncStorageDal(offlineDatabase: db);
    final res = await dal.applyAuthoritativeDeltaPage(
      ownerScope: config.ownerScope,
      expectedCheckpoint: config.expectedCheckpoint,
      page: SyncChangesPage(
        currentServerRevision: config.currentServerRevision,
        minActiveRevision: '0',
        nextRevision: config.nextRevision,
        hasMore: config.hasMore,
        changes: <SyncChangeItem>[
          SyncChangeItem.typed(
            revision: config.changeRevision,
            domain: SyncDomain.bookmark,
            entityId: config.entityId,
            operation: SyncOperation.upsert,
            payload: <String, Object?>{'title': config.title},
          ),
        ],
      ),
    );

    resultPayload = <String, Object?>{
      'status': 'ok',
      'newCheckpoint': res.newCheckpoint,
      'appliedCount': res.appliedCount,
      'hasMore': res.hasMore,
    };
  } catch (e) {
    if (!sentReady) {
      config.readyPort.send(<String, Object?>{'initError': e.toString()});
    } else {
      resultPayload = <String, Object?>{
        'status': 'error',
        'isCheckpointConflict': e is CheckpointConflictError,
        'errorType': e.runtimeType.toString(),
        'message': e.toString(),
      };
    }
  } finally {
    commandPort.close();
    if (db.isInitialized) {
      await db.close();
    }
    if (resultPayload != null) {
      config.resultPort.send(resultPayload);
    }
  }
}

Future<void> _interleavedWinnerWorkerEntry(
  _InterleavedWinnerWorkerConfig config,
) async {
  sqfliteFfiInit();
  final commandPort = ReceivePort();
  final db = OfflineDatabase();
  var sentReady = false;
  Map<String, Object?>? resultPayload;

  try {
    await db.initialize(
      customPath: config.dbPath,
      databaseFactory: databaseFactoryFfiNoIsolate,
      singleInstance: false,
    );
    config.readyPort.send(commandPort.sendPort);
    sentReady = true;

    await commandPort.first;

    final dal = SyncStorageDal(offlineDatabase: db);
    final res = await dal.applyAuthoritativeDeltaPage(
      ownerScope: config.ownerScope,
      expectedCheckpoint: '50',
      page: SyncChangesPage(
        currentServerRevision: '100',
        minActiveRevision: '0',
        nextRevision: '70',
        hasMore: true,
        changes: <SyncChangeItem>[
          SyncChangeItem.typed(
            revision: '70',
            domain: SyncDomain.bookmark,
            entityId: 'story-winner-A',
            operation: SyncOperation.upsert,
          ),
        ],
      ),
      onBeforeCommitHook: (_) async {
        config.lockHeldPort.send(null);
        await Future<void>.delayed(const Duration(milliseconds: 150));
      },
    );

    resultPayload = <String, Object?>{
      'status': 'ok',
      'newCheckpoint': res.newCheckpoint,
      'appliedCount': res.appliedCount,
    };
  } catch (e) {
    if (!sentReady) {
      config.readyPort.send(<String, Object?>{'initError': e.toString()});
    } else {
      resultPayload = <String, Object?>{
        'status': 'error',
        'isCheckpointConflict': e is CheckpointConflictError,
        'errorType': e.runtimeType.toString(),
        'message': e.toString(),
      };
    }
  } finally {
    commandPort.close();
    if (db.isInitialized) {
      await db.close();
    }
    if (resultPayload != null) {
      config.resultPort.send(resultPayload);
    }
  }
}
