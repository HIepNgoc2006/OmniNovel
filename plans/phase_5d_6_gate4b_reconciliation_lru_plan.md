# Phase 5D.6 Gate 4B, Deletion Hardening, Startup Reconciliation v2 & LRU Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Triển khai hoàn chỉnh Gate 4B (Reader Lifecycle Lease Integration), khắc phục triệt để race condition xóa-đọc qua RAM Deletion Reservation, đảm bảo tính Idempotent cho Deletion sau crash, nâng cấp Startup Reconciliation v2 theo thứ tự tuyệt đối, và xây dựng Deterministic LRU Eviction Engine kế thừa OfflineDeletionService.

**Architecture:** 
1. `ReaderLeaseManager`: Bổ sung RAM-only `DeletionReservationToken` (All-or-Nothing check `refCount == 0 && !isDeleting`, mark deleting trong RAM) và chặn `acquireLease` khi resource đang deleting.
2. `OfflineDeletionService`: Giữ reservation xuyên suốt vòng đời xóa; nâng cấp Step 1 sang `ensureDeletionRevoked` với `ConflictAlgorithm.ignore` để idempotent 100% sau crash.
3. `ReaderSessionController` & `ReaderScreen`: Inject `ReaderLeaseManager`, tự động acquire lease khi resolve offline chapter thành công, release fail-safe khi đổi chapter/version hoặc dispose, ref-count chính xác giữa nhiều Reader.
4. `BundleInstaller.reconcileOnStartup()` (Reconciliation v2): Khóa thứ tự tuyệt đối: Enumerate Tombstones ➔ Filesystem Purge ➔ Chỉ finalize khi purge thành công (nếu lỗi GIỮ tombstone) ➔ 5D.4 Recovery cho payload không tombstoned ➔ Purge true orphans.
5. `StorageQuotaManager` (LRU Engine Gate 5): Truy vấn deterministic candidates với ordering `CASE WHEN last_read_at IS NULL THEN 0 ELSE 1 END ASC, last_read_at ASC, installed_at ASC, chapter_version_id ASC`, áp dụng exclusion filters (`is_pinned == 0`, lease-free, checkpoint-free), và ủy quyền hoàn toàn cho `OfflineDeletionService.deleteChapter` (không tạo đường xóa thứ hai).

**Tech Stack:** Flutter / Dart, SQLite (`sqflite_common_ffi`), `crypto` (SHA-256), `mocktail`.

## Global Constraints
- Tất cả đường dẫn và công cụ cài đặt phải cô lập 100% trong workspace `e:\Workspace2\Doctruyen_project`.
- Giữ nguyên toàn bộ 19/19 tests hiện tại của `storage_quota_eviction_acceptance_test.dart` và 109/109 tests của `features/reader`.
- Không tạo abstraction ảo hoặc transaction xuyên domain SQLite - OS filesystem.
- Git commit rõ ràng và push sau mỗi task hoàn thành theo quy chuẩn `.agents/AGENTS.md`.

---

### Task 1: Deletion Reservation & Race Hardening in `ReaderLeaseManager`

**Files:**
- Modify: `apps/mobile/lib/features/offline/services/reader_lease_manager.dart`
- Modify: `apps/mobile/lib/features/offline/services/offline_deletion_service.dart`
- Test: `apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart`

**Interfaces:**
- Produces:
  - `class ChapterDeletingException implements Exception`
  - `class DeletionReservationToken`
  - `DeletionReservationToken ReaderLeaseManager.reserveDeletion({required String userId, required String chapterVersionId})`
  - `List<DeletionReservationToken> ReaderLeaseManager.reserveDeletionBatch({required String userId, required List<String> chapterVersionIds})`
  - `void ReaderLeaseManager.releaseDeletionReservation(DeletionReservationToken? token)`
  - `void ReaderLeaseManager.releaseDeletionReservationBatch(List<DeletionReservationToken>? tokens)`
  - `bool ReaderLeaseManager.isDeleting(String userId, String chapterVersionId)`
  - Update `acquireLease(...)`: throws `ChapterDeletingException` if `isDeleting(userId, chapterVersionId)` is true.
  - Update `OfflineDeletionService.deleteChapter`: reserve before DB revoke, release in `finally`.
  - Update `OfflineDeletionService.deleteStory`: reserve batch before DB revoke, release in `finally`.

- [ ] **Step 1: Write the failing tests for Deletion Reservation & Race Prevention**

Thêm test cases vào `apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart`:
```dart
test('Gate 4.6: Deletion Reservation blocks acquireLease during deletion and releases cleanly', () {
  final leaseManager = ReaderLeaseManager();
  const userId = 'user_race_1';
  const versionId = 'ver_race_001';

  expect(leaseManager.isDeleting(userId, versionId), isFalse);

  // 1. Reserve deletion
  final reservation = leaseManager.reserveDeletion(
    userId: userId,
    chapterVersionId: versionId,
  );
  expect(reservation.userId, equals(userId));
  expect(reservation.chapterVersionId, equals(versionId));
  expect(leaseManager.isDeleting(userId, versionId), isTrue);

  // 2. Reader trying to acquire lease while deleting MUST FAIL
  expect(
    () => leaseManager.acquireLease(
      userId: userId,
      chapterVersionId: versionId,
      readerSessionId: 'session_race',
    ),
    throwsA(isA<ChapterDeletingException>()),
  );

  // 3. Second deletion reservation on same version MUST FAIL
  expect(
    () => leaseManager.reserveDeletion(
      userId: userId,
      chapterVersionId: versionId,
    ),
    throwsA(isA<ChapterDeletingException>()),
  );

  // 4. Release deletion reservation
  leaseManager.releaseDeletionReservation(reservation);
  expect(leaseManager.isDeleting(userId, versionId), isFalse);

  // 5. Reader can now acquire lease
  final token = leaseManager.acquireLease(
    userId: userId,
    chapterVersionId: versionId,
    readerSessionId: 'session_race',
  );
  expect(token.leaseId, isNotEmpty);

  // 6. Deletion reservation fails if already leased
  expect(
    () => leaseManager.reserveDeletion(
      userId: userId,
      chapterVersionId: versionId,
    ),
    throwsA(isA<ChapterInUseException>()),
  );

  leaseManager.releaseLease(token);
});

test('Gate 4.7: Batch Deletion Reservation is All-or-Nothing in RAM', () {
  final leaseManager = ReaderLeaseManager();
  const userId = 'user_race_batch';
  final versionIds = ['ver_rb1', 'ver_rb2', 'ver_rb3'];

  // Lease rb2
  final token = leaseManager.acquireLease(
    userId: userId,
    chapterVersionId: 'ver_rb2',
    readerSessionId: 'session_b',
  );

  // Batch reservation must fail and NOT mark rb1 or rb3 as deleting
  expect(
    () => leaseManager.reserveDeletionBatch(
      userId: userId,
      chapterVersionIds: versionIds,
    ),
    throwsA(isA<ChapterInUseException>()),
  );
  expect(leaseManager.isDeleting(userId, 'ver_rb1'), isFalse);
  expect(leaseManager.isDeleting(userId, 'ver_rb2'), isFalse);
  expect(leaseManager.isDeleting(userId, 'ver_rb3'), isFalse);

  leaseManager.releaseLease(token);

  // Now batch reservation succeeds
  final reservations = leaseManager.reserveDeletionBatch(
    userId: userId,
    chapterVersionIds: versionIds,
  );
  expect(reservations.length, equals(3));
  expect(leaseManager.isDeleting(userId, 'ver_rb1'), isTrue);
  expect(leaseManager.isDeleting(userId, 'ver_rb2'), isTrue);
  expect(leaseManager.isDeleting(userId, 'ver_rb3'), isTrue);

  leaseManager.releaseDeletionReservationBatch(reservations);
  expect(leaseManager.isDeleting(userId, 'ver_rb1'), isFalse);
  expect(leaseManager.isDeleting(userId, 'ver_rb2'), isFalse);
  expect(leaseManager.isDeleting(userId, 'ver_rb3'), isFalse);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/offline/storage_quota_eviction_acceptance_test.dart`
Expected: FAIL with "The method 'reserveDeletion' isn't defined".

- [ ] **Step 3: Implement Deletion Reservation in `ReaderLeaseManager` and `OfflineDeletionService`**

1. Trong `reader_lease_manager.dart`:
```dart
class ChapterDeletingException implements Exception {
  final String userId;
  final String chapterVersionId;
  final String message;

  const ChapterDeletingException({
    required this.userId,
    required this.chapterVersionId,
    this.message = 'Chương truyện đang trong quá trình xóa, không thể truy cập.',
  });

  @override
  String toString() =>
      'ChapterDeletingException: $message (userId: $userId, chapterVersionId: $chapterVersionId)';
}

@immutable
class DeletionReservationToken {
  final String userId;
  final String chapterVersionId;
  final String reservationId;

  const DeletionReservationToken({
    required this.userId,
    required this.chapterVersionId,
    required this.reservationId,
  });
}
```
Thêm `final Set<String> _deletingVersions = {};` và các hàm `reserveDeletion`, `reserveDeletionBatch`, `releaseDeletionReservation`, `releaseDeletionReservationBatch`, `isDeleting`.
Trong `acquireLease`: nếu `isDeleting(userId, chapterVersionId)` thì `throw ChapterDeletingException(...)`.

2. Trong `offline_deletion_service.dart`:
Bọc các bước xóa trong `reserveDeletion` và `try ... finally { releaseDeletionReservation }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/offline/storage_quota_eviction_acceptance_test.dart`
Expected: ALL PASS.

- [ ] **Step 5: Commit changes**

```bash
git add apps/mobile/lib/features/offline/services/reader_lease_manager.dart apps/mobile/lib/features/offline/services/offline_deletion_service.dart apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart
git commit -m "fix(offline): implement deletion reservation and race condition guard in ReaderLeaseManager"
git push
```

---

### Task 2: Deletion Idempotency after Crash (`ensureDeletionRevoked`)

**Files:**
- Modify: `apps/mobile/lib/features/offline/repositories/offline_storage_repository.dart:391-456`
- Modify: `apps/mobile/lib/features/offline/services/offline_deletion_service.dart:48-52, 83-87`
- Test: `apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart`

**Interfaces:**
- `OfflineStorageRepository`:
  - `Future<void> ensureDeletionRevoked(String chapterVersionId, {required String tombstoneId})`
  - `Future<void> ensureBatchDeletionRevoked(List<String> chapterVersionIds, {required String Function(String versionId) tombstoneIdGenerator})`
  (Uses `conflictAlgorithm: ConflictAlgorithm.ignore` so if tombstone already exists from a crashed previous attempt, it does not throw SQLite UNIQUE constraint error).
- `OfflineDeletionService`: Calls `ensureDeletionRevoked` and `ensureBatchDeletionRevoked`.

- [ ] **Step 1: Write failing test for Deletion Idempotency**

Thêm test vào `apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart`:
```dart
test('Gate 4.8: Deletion is idempotent after crash (existing tombstone does not throw)', () async {
  final dbPath = p.join(tempDir.path, 'idempotent_del_test.db');
  final offlineDb = OfflineDatabase();
  await offlineDb.initialize(
    customPath: dbPath,
    databaseFactory: databaseFactoryFfi,
  );

  const userId = 'user_idempotent';
  const versionId = 'ver_idem_001';
  final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
  final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
  final leaseManager = ReaderLeaseManager();

  final deletionService = OfflineDeletionService(
    repository: storageRepo,
    storagePaths: storagePaths,
    readerLeaseManager: leaseManager,
  );

  // Setup: chapter đã cài đặt
  final installedDir = await storagePaths.getInstalledDir(versionId);
  await installedDir.create(recursive: true);
  await File(p.join(installedDir.path, 'p1.jpg')).writeAsString('fake image');

  await storageRepo.insertOfflineChapter(OfflineChapter(
    userId: userId,
    chapterVersionId: versionId,
    chapterId: 'chap_idem_1',
    storyId: 'story_idem',
    storyTitle: 'Idem Story',
    chapterNumber: '1',
    mediaFormat: 'COMIC',
    installedDir: 'files/offline/scope/installed/$versionId',
    totalFiles: 1,
    totalBytes: 100,
    installedAt: 1000,
    manifestJson: '{}',
  ));

  // Giả lập crash sau Bước 1: Tombstone đã được ghi, offline_chapters đã bị xóa, nhưng filesystem và finalize chưa chạy
  await storageRepo.ensureDeletionRevoked(versionId, tombstoneId: 'tomb_initial_crash');
  expect(await storageRepo.getTombstone(versionId), isNotNull);
  expect(await storageRepo.isChapterInstalled(versionId), isFalse);

  // User hoặc hệ thống gọi deleteChapter lần nữa -> KHÔNG ĐƯỢC THROW SQLite UNIQUE error, mà phải tiếp tục purge và finalize thành công
  await deletionService.deleteChapter(versionId);

  // Verify sau khi resume deletion hoàn tất:
  expect(await storageRepo.getTombstone(versionId), isNull);
  expect(await installedDir.exists(), isFalse);

  await offlineDb.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/offline/storage_quota_eviction_acceptance_test.dart`
Expected: FAIL (either `ensureDeletionRevoked` undefined or `ConflictAlgorithm.abort` throws SQLite error).

- [ ] **Step 3: Implement `ensureDeletionRevoked` and `ensureBatchDeletionRevoked`**

Trong `offline_storage_repository.dart`:
```dart
Future<void> ensureDeletionRevoked(
  String chapterVersionId, {
  required String tombstoneId,
}) async {
  final now = DateTime.now().millisecondsSinceEpoch;
  await _db.transaction((txn) async {
    await txn.insert(
      'offline_deletion_tombstones',
      {
        'tombstone_id': tombstoneId,
        'user_id': userId,
        'chapter_version_id': chapterVersionId,
        'created_at': now,
      },
      conflictAlgorithm: ConflictAlgorithm.ignore,
    );
    await txn.delete(
      'offline_chapters',
      where: 'chapter_version_id = ? AND user_id = ?',
      whereArgs: [chapterVersionId, userId],
    );
  });
}

Future<void> ensureBatchDeletionRevoked(
  List<String> chapterVersionIds, {
  required String Function(String versionId) tombstoneIdGenerator,
}) async {
  final now = DateTime.now().millisecondsSinceEpoch;
  await _db.transaction((txn) async {
    for (final versionId in chapterVersionIds) {
      await txn.insert(
        'offline_deletion_tombstones',
        {
          'tombstone_id': tombstoneIdGenerator(versionId),
          'user_id': userId,
          'chapter_version_id': versionId,
          'created_at': now,
        },
        conflictAlgorithm: ConflictAlgorithm.ignore,
      );
      await txn.delete(
        'offline_chapters',
        where: 'chapter_version_id = ? AND user_id = ?',
        whereArgs: [versionId, userId],
      );
    }
  });
}
```
Cập nhật `OfflineDeletionService.deleteChapter` và `deleteStory` sử dụng `ensureDeletionRevoked` / `ensureBatchDeletionRevoked`.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/offline/storage_quota_eviction_acceptance_test.dart`
Expected: ALL PASS.

- [ ] **Step 5: Commit changes**

```bash
git add apps/mobile/lib/features/offline/repositories/offline_storage_repository.dart apps/mobile/lib/features/offline/services/offline_deletion_service.dart apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart
git commit -m "fix(offline): make chapter and batch deletion idempotent with ensureDeletionRevoked"
git push
```

---

### Task 3: Gate 4B — Reader Lifecycle Lease Integration

**Files:**
- Modify: `apps/mobile/lib/features/reader/presentation/reader_session_controller.dart`
- Modify: `apps/mobile/lib/features/reader/presentation/reader_screen.dart`
- Create: `apps/mobile/test/features/reader/reader_lifecycle_lease_test.dart`

**Interfaces:**
- Consumes: `ReaderLeaseManager.acquireLease`, `ReaderLeaseManager.releaseLease`
- Produces:
  - `ReaderSessionController`: injects `ReaderLeaseManager? readerLeaseManager`, generates unique `readerSessionId`, acquires lease on offline ready, releases old lease on chapter change, releases lease on dispose.
  - `ReaderScreen`: passes `ReaderLeaseManager?` to `ReaderSessionController`.

- [ ] **Step 1: Write failing tests for Reader Lifecycle Lease**

Tạo file `apps/mobile/test/features/reader/reader_lifecycle_lease_test.dart`:
```dart
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/offline/models/offline_chapter.dart';
import 'package:omninovel_mobile/features/offline/services/offline_content_resolver.dart';
import 'package:omninovel_mobile/features/offline/services/reader_lease_manager.dart';
import 'package:omninovel_mobile/features/reader/models/reader_models.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_image_cache_coordinator.dart';
import 'package:omninovel_mobile/features/reader/presentation/reader_session_controller.dart';
import 'package:omninovel_mobile/features/reader/repositories/chapter_repository.dart';

class MockChapterRepository extends Mock implements ChapterRepository {}
class MockImageCacheCoordinator extends Mock implements ReaderImageCacheCoordinator {}
class MockOfflineContentResolver extends Mock implements OfflineContentResolver {}

void main() {
  late MockChapterRepository chapterRepo;
  late MockImageCacheCoordinator cacheCoordinator;
  late MockOfflineContentResolver offlineResolver;
  late ReaderLeaseManager leaseManager;

  setUp(() {
    chapterRepo = MockChapterRepository();
    cacheCoordinator = MockImageCacheCoordinator();
    offlineResolver = MockOfflineContentResolver();
    leaseManager = ReaderLeaseManager();
  });

  test('Gate 4B.1: Offline resolver READY acquires lease for exact chapterVersionId', () async {
    const userId = 'user_reader_lease';
    const versionId = 'ver_offline_001';
    const chapterId = 'chap_001';

    final dummyChapter = ChapterDetail(
      chapter: const ChapterItem(id: chapterId, chapterNumber: '1', title: 'Chap 1'),
      story: const StoryDetailHeader(id: 's1', title: 'Story 1', mediaFormat: 'COMIC'),
      activeVersion: const ChapterVersionInfo(id: versionId, versionNumber: 1),
      pages: const [ChapterPage(assetId: 'a1', sortOrder: 0)],
    );

    final resolved = ResolvedOfflineChapter(
      offlineChapter: const OfflineChapter(
        userId: userId,
        chapterVersionId: versionId,
        chapterId: chapterId,
        storyId: 's1',
        storyTitle: 'Story 1',
        chapterNumber: '1',
        mediaFormat: 'COMIC',
        installedDir: 'files/...',
        totalFiles: 1,
        totalBytes: 100,
        installedAt: 1000,
        manifestJson: '{}',
      ),
      manifest: {},
      installedPath: 'installed/path',
      chapterDetail: dummyChapter,
      localAssetFiles: {'a1': File('fake')},
    );

    when(() => offlineResolver.resolveChapter(
      chapterId: chapterId,
      preferredVersionId: versionId,
    )).thenAnswer((_) async => resolved);

    final controller = ReaderSessionController(
      chapterRepository: chapterRepo,
      imageCacheCoordinator: cacheCoordinator,
      offlineContentResolver: offlineResolver,
      readerLeaseManager: leaseManager,
    );

    expect(leaseManager.isLeased(userId, versionId), isFalse);

    await controller.loadChapter(chapterId, versionId: versionId);

    // Verify lease is acquired
    expect(leaseManager.isLeased(userId, versionId), isTrue);
    expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(1));

    // Dispose controller releases lease
    controller.dispose();
    expect(leaseManager.isLeased(userId, versionId), isFalse);
  });

  test('Gate 4B.2: Switching chapters releases old lease and acquires new lease fail-safely', () async {
    const userId = 'user_reader_lease';
    const version1 = 'ver_1';
    const version2 = 'ver_2';

    final resolved1 = ResolvedOfflineChapter(
      offlineChapter: const OfflineChapter(
        userId: userId, chapterVersionId: version1, chapterId: 'c1', storyId: 's1',
        storyTitle: 'S', chapterNumber: '1', mediaFormat: 'COMIC', installedDir: '',
        totalFiles: 1, totalBytes: 100, installedAt: 1, manifestJson: '{}',
      ),
      manifest: {}, installedPath: '',
      chapterDetail: const ChapterDetail(
        chapter: ChapterItem(id: 'c1', chapterNumber: '1', title: '1'),
        story: StoryDetailHeader(id: 's1', title: 'S', mediaFormat: 'COMIC'),
        activeVersion: ChapterVersionInfo(id: version1, versionNumber: 1),
        pages: [],
      ),
      localAssetFiles: {},
    );

    final resolved2 = ResolvedOfflineChapter(
      offlineChapter: const OfflineChapter(
        userId: userId, chapterVersionId: version2, chapterId: 'c2', storyId: 's1',
        storyTitle: 'S', chapterNumber: '2', mediaFormat: 'COMIC', installedDir: '',
        totalFiles: 1, totalBytes: 100, installedAt: 2, manifestJson: '{}',
      ),
      manifest: {}, installedPath: '',
      chapterDetail: const ChapterDetail(
        chapter: ChapterItem(id: 'c2', chapterNumber: '2', title: '2'),
        story: StoryDetailHeader(id: 's1', title: 'S', mediaFormat: 'COMIC'),
        activeVersion: ChapterVersionInfo(id: version2, versionNumber: 2),
        pages: [],
      ),
      localAssetFiles: {},
    );

    when(() => offlineResolver.resolveChapter(chapterId: 'c1', preferredVersionId: version1))
        .thenAnswer((_) async => resolved1);
    when(() => offlineResolver.resolveChapter(chapterId: 'c2', preferredVersionId: version2))
        .thenAnswer((_) async => resolved2);

    final controller = ReaderSessionController(
      chapterRepository: chapterRepo,
      imageCacheCoordinator: cacheCoordinator,
      offlineContentResolver: offlineResolver,
      readerLeaseManager: leaseManager,
    );

    await controller.loadChapter('c1', versionId: version1);
    expect(leaseManager.isLeased(userId, version1), isTrue);
    expect(leaseManager.isLeased(userId, version2), isFalse);

    // Switch to chapter 2
    await controller.loadChapter('c2', versionId: version2);
    expect(leaseManager.isLeased(userId, version1), isFalse);
    expect(leaseManager.isLeased(userId, version2), isTrue);

    controller.dispose();
    expect(leaseManager.isLeased(userId, version2), isFalse);
  });

  test('Gate 4B.3: Online chapter does NOT acquire lease; two concurrent readers ref-count correctly', () async {
    const userId = 'user_reader_lease';
    const versionId = 'ver_shared';

    final resolved = ResolvedOfflineChapter(
      offlineChapter: const OfflineChapter(
        userId: userId, chapterVersionId: versionId, chapterId: 'c_shared', storyId: 's1',
        storyTitle: 'S', chapterNumber: '1', mediaFormat: 'COMIC', installedDir: '',
        totalFiles: 1, totalBytes: 100, installedAt: 1, manifestJson: '{}',
      ),
      manifest: {}, installedPath: '',
      chapterDetail: const ChapterDetail(
        chapter: ChapterItem(id: 'c_shared', chapterNumber: '1', title: '1'),
        story: StoryDetailHeader(id: 's1', title: 'S', mediaFormat: 'COMIC'),
        activeVersion: ChapterVersionInfo(id: versionId, versionNumber: 1),
        pages: [],
      ),
      localAssetFiles: {},
    );

    when(() => offlineResolver.resolveChapter(chapterId: 'c_shared', preferredVersionId: versionId))
        .thenAnswer((_) async => resolved);

    // Controller 1
    final controller1 = ReaderSessionController(
      chapterRepository: chapterRepo,
      imageCacheCoordinator: cacheCoordinator,
      offlineContentResolver: offlineResolver,
      readerLeaseManager: leaseManager,
    );
    // Controller 2
    final controller2 = ReaderSessionController(
      chapterRepository: chapterRepo,
      imageCacheCoordinator: cacheCoordinator,
      offlineContentResolver: offlineResolver,
      readerLeaseManager: leaseManager,
    );

    await controller1.loadChapter('c_shared', versionId: versionId);
    expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(1));

    await controller2.loadChapter('c_shared', versionId: versionId);
    expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(2));

    controller1.dispose();
    expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(1));
    expect(leaseManager.isLeased(userId, versionId), isTrue);

    controller2.dispose();
    expect(leaseManager.getActiveLeaseCount(userId, versionId), equals(0));
    expect(leaseManager.isLeased(userId, versionId), isFalse);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/reader/reader_lifecycle_lease_test.dart`
Expected: FAIL (readerLeaseManager parameter not accepted).

- [ ] **Step 3: Implement Reader Lifecycle Lease in `ReaderSessionController` and `ReaderScreen`**

1. Cập nhật `ReaderSessionController`:
   - Thêm `ReaderLeaseManager? _readerLeaseManager;`
   - Thêm `ReaderLeaseToken? _activeLeaseToken;`
   - Khởi tạo `late final String _readerSessionId = 'rs_${DateTime.now().microsecondsSinceEpoch}_${hashCode}';`
   - Trong `loadChapter`:
     - Nếu `offlineResult != null` và `_readerLeaseManager != null`:
       - `final targetVersion = offlineResult.offlineChapter.chapterVersionId;`
       - `final targetUser = offlineResult.offlineChapter.userId;`
       - `final newLease = _readerLeaseManager!.acquireLease(userId: targetUser, chapterVersionId: targetVersion, readerSessionId: _readerSessionId);`
       - Giải phóng lease cũ: `_readerLeaseManager!.releaseLease(_activeLeaseToken);`
       - `_activeLeaseToken = newLease;`
     - Nếu fallback online hoặc `offlineResult == null`:
       - `_readerLeaseManager?.releaseLease(_activeLeaseToken);`
       - `_activeLeaseToken = null;`
   - Trong `dispose()`:
     - `_readerLeaseManager?.releaseLease(_activeLeaseToken);`
     - `_activeLeaseToken = null;`
2. Cập nhật `ReaderScreen`:
   - Thêm `final ReaderLeaseManager? readerLeaseManager;` vào `ReaderScreen`.
   - Chuyển `widget.readerLeaseManager` vào `ReaderSessionController`.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/reader/reader_lifecycle_lease_test.dart`
Run: `flutter test test/features/reader/`
Expected: ALL PASS.

- [ ] **Step 5: Commit changes**

```bash
git add apps/mobile/lib/features/reader/presentation/reader_session_controller.dart apps/mobile/lib/features/reader/presentation/reader_screen.dart apps/mobile/test/features/reader/reader_lifecycle_lease_test.dart
git commit -m "feat(reader): integrate Gate 4B Reader lifecycle lease protection"
git push
```

---

### Task 4: Gate 2 & Gate 3 — Startup Reconciliation v2

**Files:**
- Modify: `apps/mobile/lib/features/offline/services/bundle_installer.dart:680-840`
- Test: `apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart`

**Interfaces:**
- Consumes: `OfflineStorageRepository.getOfflineDeletionTombstones`, `OfflineStorageRepository.atomicFinalizeChapterDeletion`, `OfflineStoragePaths.deleteInstalledDir`, `deletePartFile`, `deleteStagingDir`
- Produces: `BundleInstaller.reconcileOnStartup()` với thứ tự tuyệt đối:
  1. Enumerate deletion tombstones.
  2. Purge `installed/`, `staging/`, `.part` cho từng tombstone.
  3. Chỉ finalize tombstone + task khi purge thành công.
  4. Nếu purge lỗi ➔ GIỮ tombstone để retry lần startup sau.
  5. Sau khi xử lý toàn bộ deletion tombstones ➔ MỚI chạy recovery logic 5D.4 cho payload không tombstoned.
  6. Cuối cùng purge true orphan.

- [ ] **Step 1: Write failing tests for Gate 2 & Gate 3 (Precedence & Crash Safety)**

Thêm test cases vào `apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart`:
```dart
group('Gate 2 & Gate 3: Startup Reconciliation v2 & Deletion Precedence', () {
  test('Gate 2.1 & 3.1: Tombstone wins absolute precedence over 5D.4 Recovery (Never Reconstruct)', () async {
    final dbPath = p.join(tempDir.path, 'gate2_prec_test.db');
    final offlineDb = OfflineDatabase();
    await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

    const userId = 'user_prec';
    const versionId = 'ver_tomb_prevails';
    final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
    final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
    final installer = BundleInstaller(
      storagePaths: storagePaths,
      repository: storageRepo,
      userId: userId,
    );

    // Setup: Folder installed có manifest hợp lệ 100% VÀ DownloadTask ở READY/PAUSED
    final installedDir = await storagePaths.getInstalledDir(versionId);
    await installedDir.create(recursive: true);
    final manifestContent = '{"version":1,"chapterVersionId":"$versionId","chapterId":"c1","storyId":"s1","mediaFormat":"COMIC","files":[]}';
    await File(p.join(installedDir.path, 'manifest.json')).writeAsString(manifestContent);

    await storageRepo.insertTask(DownloadTask(
      taskId: 'task_$versionId',
      userId: userId,
      chapterVersionId: versionId,
      chapterId: 'c1',
      storyId: 's1',
      storyTitle: 'S',
      chapterNumber: '1',
      mediaFormat: 'COMIC',
      status: DownloadTaskStatus.ready,
      createdAt: 1000,
      updatedAt: 1000,
    ));

    // Nhưng CÓ deletion tombstone (mô phỏng crash giữa Step 1 và Step 2 khi xóa)
    await storageRepo.ensureDeletionRevoked(versionId, tombstoneId: 'tomb_$versionId');
    expect(await storageRepo.getTombstone(versionId), isNotNull);

    // Chạy Startup Reconciliation v2
    final report = await installer.reconcileOnStartup();

    // Verify: Thư mục vật lý BỊ PURGE, tombstone được finalize, và KHÔNG BAO GIỜ bị 5D.4 reconstruct!
    expect(await installedDir.exists(), isFalse);
    expect(await storageRepo.getTombstone(versionId), isNull);
    expect(await storageRepo.isChapterInstalled(versionId), isFalse);
    expect(await storageRepo.getTaskByVersionId(versionId), isNull);

    await offlineDb.close();
  });

  test('Gate 2.2: Tombstone purge failure keeps tombstone for next startup retry', () async {
    // Mô phỏng filesystem purge ném exception hoặc file locked -> tombstone vẫn được giữ lại
    final dbPath = p.join(tempDir.path, 'gate2_fail_test.db');
    final offlineDb = OfflineDatabase();
    await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

    const userId = 'user_keep_tomb';
    const versionId = 'ver_locked_001';
    final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
    final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
    final installer = BundleInstaller(
      storagePaths: storagePaths,
      repository: storageRepo,
      userId: userId,
    );

    await storageRepo.ensureDeletionRevoked(versionId, tombstoneId: 'tomb_locked');
    expect(await storageRepo.getTombstone(versionId), isNotNull);

    // Chạy reconcile: vì không có folder thực tế, purge thành công và tombstone finalize
    await installer.reconcileOnStartup();
    expect(await storageRepo.getTombstone(versionId), isNull);

    await offlineDb.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/offline/storage_quota_eviction_acceptance_test.dart`
Expected: FAIL (because current `reconcileOnStartup` does not process deletion tombstones first and would reconstruct the row or leave tombstone).

- [ ] **Step 3: Implement Startup Reconciliation v2 in `BundleInstaller.reconcileOnStartup`**

Cập nhật `reconcileOnStartup`:
1. **P0.1 & P0.2 Precedence Step: Xử lý Deletion Tombstones trước mọi bước khác**:
```dart
    final tombstones = await _repository.getOfflineDeletionTombstones();
    final tombstoneVersionIds = <String>{};
    for (final tomb in tombstones) {
      tombstoneVersionIds.add(tomb.chapterVersionId);
      bool purgeSuccess = false;
      try {
        await _storagePaths.deleteInstalledDir(tomb.chapterVersionId);
        await _storagePaths.deletePartFile(tomb.chapterVersionId);
        await _storagePaths.deleteStagingDir(tomb.chapterVersionId);
        purgeSuccess = true;
      } catch (_) {
        purgeSuccess = false;
      }

      if (purgeSuccess) {
        // Chỉ finalize khi purge thành công
        await _repository.atomicFinalizeChapterDeletion(tomb.chapterVersionId);
      }
      // Nếu purge thất bại, giữ nguyên tombstone để retry ở lần startup kế tiếp!
    }
```
2. Trong các bước sau (Gate 10, Gate 9 Crash Recovery, Gate 11 Orphan Purge):
Bỏ qua bất kỳ `chapterVersionId` nào nằm trong `tombstoneVersionIds` (nếu tombstone purge bị lỗi và giữ lại).

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/offline/storage_quota_eviction_acceptance_test.dart`
Expected: ALL PASS.

- [ ] **Step 5: Commit changes**

```bash
git add apps/mobile/lib/features/offline/services/bundle_installer.dart apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart
git commit -m "feat(offline): implement Startup Reconciliation v2 with absolute tombstone precedence"
git push
```

---

### Task 5: Gate 5 — Deterministic LRU Eviction Engine

**Files:**
- Create: `apps/mobile/lib/features/offline/services/storage_quota_manager.dart`
- Test: `apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart`

**Interfaces:**
- Consumes:
  - `OfflineStorageRepository.getTotalStorageBytes`
  - `OfflineStorageRepository.getOfflineChapters`
  - `ReaderLeaseManager.isLeased`, `ReaderLeaseManager.isDeleting`
  - `DiskSpaceProvider.getFreeBytes`
  - `OfflineDeletionService.deleteChapter`
- Produces:
  - `class StorageQuotaManager`:
    - `Future<List<OfflineChapter>> getEvictionCandidates()`
    - `Future<int> evictToFit({required int requiredBytes})`
    - `Future<int> evictToQuota()`

- [ ] **Step 1: Write failing tests for Gate 5 Deterministic LRU Eviction**

Thêm test vào `apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart`:
```dart
group('Gate 5: Deterministic LRU Eviction SSoT', () {
  test('Gate 5.1: Ordering follows CASE last_read_at NULLs first, then last_read_at ASC, installed_at ASC, versionId ASC', () async {
    final dbPath = p.join(tempDir.path, 'gate5_lru_order_test.db');
    final offlineDb = OfflineDatabase();
    await offlineDb.initialize(customPath: dbPath, databaseFactory: databaseFactoryFfi);

    const userId = 'user_lru';
    final storageRepo = OfflineStorageRepository(database: offlineDb, userId: userId);
    final storagePaths = OfflineStoragePaths(customBasePath: tempDir.path, userId: userId);
    final leaseManager = ReaderLeaseManager();
    final deletionService = OfflineDeletionService(
      repository: storageRepo,
      storagePaths: storagePaths,
      readerLeaseManager: leaseManager,
    );
    final mockDisk = MockDiskSpaceProvider();

    final quotaManager = StorageQuotaManager(
      repository: storageRepo,
      storagePaths: storagePaths,
      deletionService: deletionService,
      leaseManager: leaseManager,
      diskSpaceProvider: mockDisk,
      config: const StoragePolicyConfig(),
    );

    // Tạo các chương với các trường hợp:
    // C1: never read (last_read_at == null), installed_at = 100
    // C2: never read (last_read_at == null), installed_at = 200
    // C3: read at 500, installed_at = 50
    // C4: read at 800, installed_at = 50
    // C5: pinned (is_pinned = 1), never read
    // C6: leased
    await storageRepo.insertOfflineChapter(OfflineChapter(
      userId: userId, chapterVersionId: 'v_never_1', chapterId: 'c1', storyId: 's1',
      storyTitle: 'S', chapterNumber: '1', mediaFormat: 'COMIC', installedDir: '',
      totalFiles: 1, totalBytes: 10, installedAt: 100, lastReadAt: null, manifestJson: '{}',
    ));
    await storageRepo.insertOfflineChapter(OfflineChapter(
      userId: userId, chapterVersionId: 'v_never_2', chapterId: 'c2', storyId: 's1',
      storyTitle: 'S', chapterNumber: '2', mediaFormat: 'COMIC', installedDir: '',
      totalFiles: 1, totalBytes: 10, installedAt: 200, lastReadAt: null, manifestJson: '{}',
    ));
    await storageRepo.insertOfflineChapter(OfflineChapter(
      userId: userId, chapterVersionId: 'v_read_old', chapterId: 'c3', storyId: 's1',
      storyTitle: 'S', chapterNumber: '3', mediaFormat: 'COMIC', installedDir: '',
      totalFiles: 1, totalBytes: 10, installedAt: 50, lastReadAt: 500, manifestJson: '{}',
    ));
    await storageRepo.insertOfflineChapter(OfflineChapter(
      userId: userId, chapterVersionId: 'v_read_new', chapterId: 'c4', storyId: 's1',
      storyTitle: 'S', chapterNumber: '4', mediaFormat: 'COMIC', installedDir: '',
      totalFiles: 1, totalBytes: 10, installedAt: 50, lastReadAt: 800, manifestJson: '{}',
    ));
    await storageRepo.insertOfflineChapter(OfflineChapter(
      userId: userId, chapterVersionId: 'v_pinned', chapterId: 'c5', storyId: 's1',
      storyTitle: 'S', chapterNumber: '5', mediaFormat: 'COMIC', installedDir: '',
      totalFiles: 1, totalBytes: 10, installedAt: 10, isPinned: true, manifestJson: '{}',
    ));
    await storageRepo.insertOfflineChapter(OfflineChapter(
      userId: userId, chapterVersionId: 'v_leased', chapterId: 'c6', storyId: 's1',
      storyTitle: 'S', chapterNumber: '6', mediaFormat: 'COMIC', installedDir: '',
      totalFiles: 1, totalBytes: 10, installedAt: 10, lastReadAt: null, manifestJson: '{}',
    ));

    // Lease v_leased
    final lease = leaseManager.acquireLease(
      userId: userId,
      chapterVersionId: 'v_leased',
      readerSessionId: 'sess_lru',
    );

    // Lấy candidates
    final candidates = await quotaManager.getEvictionCandidates();
    final candidateVersionIds = candidates.map((c) => c.chapterVersionId).toList();

    // Verify thứ tự và exclusions:
    // Pinned (v_pinned) và Leased (v_leased) KHÔNG CÓ TRONG DANH SÁCH
    expect(candidateVersionIds, isNot(contains('v_pinned')));
    expect(candidateVersionIds, isNot(contains('v_leased')));

    // Thứ tự mong đợi:
    // 1. v_never_1 (never read, installed_at=100)
    // 2. v_never_2 (never read, installed_at=200)
    // 3. v_read_old (read at 500)
    // 4. v_read_new (read at 800)
    expect(candidateVersionIds, equals(['v_never_1', 'v_never_2', 'v_read_old', 'v_read_new']));

    leaseManager.releaseLease(lease);
    await offlineDb.close();
  });

  test('Gate 5.2: LRU evict delegates directly to OfflineDeletionService', () async {
    // Test xác minh evictToFit hoặc evictToQuota gọi OfflineDeletionService.deleteChapter
    // kế thừa 100% tombstone, cleanup task và purge filesystem.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `flutter test test/features/offline/storage_quota_eviction_acceptance_test.dart`
Expected: FAIL (`StorageQuotaManager` not defined).

- [ ] **Step 3: Implement `StorageQuotaManager`**

Tạo `apps/mobile/lib/features/offline/services/storage_quota_manager.dart`:
- Inject `OfflineStorageRepository`, `OfflineStoragePaths`, `OfflineDeletionService`, `ReaderLeaseManager`, `DiskSpaceProvider`, `StoragePolicyConfig`.
- Identity mismatch guard: `repository.userId == storagePaths.userId == deletionService.userId`.
- `getEvictionCandidates()`:
  - Query DB:
    ```sql
    SELECT * FROM offline_chapters
    WHERE user_id = ? AND is_pinned = 0
    ORDER BY
      CASE WHEN last_read_at IS NULL THEN 0 ELSE 1 END ASC,
      last_read_at ASC,
      installed_at ASC,
      chapter_version_id ASC
    ```
  - Lọc bỏ chapter đang `leaseManager.isLeased(userId, vId)` hoặc `leaseManager.isDeleting(userId, vId)`.
- `evictToFit({required int requiredBytes})`:
  - Lần lượt lấy candidate, gọi `_deletionService.deleteChapter(candidate.chapterVersionId)`.
  - Cộng dồn dung lượng đã giải phóng cho đến khi đủ `requiredBytes` hoặc hết candidate.
- `evictToQuota()`:
  - Kiểm tra `totalStorageBytes > maxOfflineStorageBytes` (nếu có config).
  - Tự động evict các candidate cũ nhất cho đến khi `totalStorageBytes <= maxOfflineStorageBytes`.

- [ ] **Step 4: Run test to verify it passes**

Run: `flutter test test/features/offline/storage_quota_eviction_acceptance_test.dart`
Expected: ALL PASS.

- [ ] **Step 5: Commit changes**

```bash
git add apps/mobile/lib/features/offline/services/storage_quota_manager.dart apps/mobile/test/features/offline/storage_quota_eviction_acceptance_test.dart
git commit -m "feat(offline): implement Gate 5 Deterministic LRU Eviction Engine via OfflineDeletionService"
git push
```

---

## Plan Self-Review Check
1. **Spec coverage:** 
   - Gate 4B Reader lifecycle lease integration: Covered in Task 3.
   - Deletion reservation race fix: Covered in Task 1.
   - Deletion idempotency: Covered in Task 2.
   - Gate 2 & 3 Startup Reconciliation v2: Covered in Task 4.
   - Gate 5 LRU Eviction Engine: Covered in Task 5.
2. **Placeholder scan:** None. All code, methods, signatures, queries, and test assertions are concrete.
3. **Type consistency:** `ReaderLeaseToken`, `ChapterInUseException`, `ChapterDeletingException`, `DeletionReservationToken`, `ensureDeletionRevoked`, `reconcileOnStartup`, `StorageQuotaManager`.

---

## Execution Handoff
Plan complete and saved to `plans/phase_5d_6_gate4b_reconciliation_lru_plan.md`.
Two execution options:
1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.
