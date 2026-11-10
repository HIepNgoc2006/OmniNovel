import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/sync/models/sync_models.dart';
import 'package:omninovel_mobile/core/sync/reconciler/mock_sync_transport.dart';

void main() {
  group('Phase 7C.4 Stage 2A — Task B: Mock Transport Harness Tests', () {
    const ownerScope = 'account:user-stage2a-002';
    late ConfigurableMockSyncTransport transport;

    setUp(() {
      transport = ConfigurableMockSyncTransport();
    });

    test('1. Successful mutation push returns APPLIED receipts and advanced server revision', () async {
      final mutations = [
        const ClientMutationWire(
          clientId: 'client-uuid-001',
          mutationId: 'mut-001',
          domain: 'BOOKMARK',
          entityId: 'story-101',
          operation: 'UPSERT',
          baseServerRevision: '100',
          payload: {'storyId': 'story-101'},
        ),
        const ClientMutationWire(
          clientId: 'client-uuid-001',
          mutationId: 'mut-002',
          domain: 'PROGRESS',
          entityId: 'story-101',
          operation: 'UPSERT',
          baseServerRevision: '100',
          payload: {'storyId': 'story-101', 'pageIndex': 5},
        ),
      ];

      final response = await transport.pushMutationsBatch(
        ownerScope: ownerScope,
        mutations: mutations,
      );

      expect(response.processedCount, 2);
      expect(response.results.length, 2);
      expect(response.results[0].mutationId, 'mut-001');
      expect(response.results[0].status, 'APPLIED');
      expect(response.results[0].assignedRevision, '101');
      expect(response.results[1].mutationId, 'mut-002');
      expect(response.results[1].status, 'APPLIED');
      expect(response.results[1].assignedRevision, '102');
      expect(response.newServerRevision, '102');
      expect(transport.pushCallCount, 1);
    });

    test('2. Transient network failure throws MockNetworkException with retry indication', () async {
      transport.shouldFailTransiently = true;
      transport.transientFailureCount = 1;

      final mutations = [
        const ClientMutationWire(
          clientId: 'client-uuid-001',
          mutationId: 'mut-transient-01',
          domain: 'BOOKMARK',
          entityId: 'story-102',
          operation: 'UPSERT',
          baseServerRevision: '100',
          payload: {},
        ),
      ];

      // Lần 1: Thất bại do timeout mạng
      expect(
        () => transport.pushMutationsBatch(
          ownerScope: ownerScope,
          mutations: mutations,
        ),
        throwsA(isA<MockNetworkException>()),
      );

      // Lần 2: Mạng tự phục hồi sau transientFailureCount = 1
      final retryResponse = await transport.pushMutationsBatch(
        ownerScope: ownerScope,
        mutations: mutations,
      );
      expect(retryResponse.processedCount, 1);
      expect(retryResponse.results.first.status, 'APPLIED');
    });

    test('3. HTTP 409 Conflict triggers MockHttpException with OCC details', () async {
      transport.shouldReturn409 = true;

      expect(
        () => transport.pushMutationsBatch(
          ownerScope: ownerScope,
          mutations: const [],
        ),
        throwsA(
          predicate<MockHttpException>(
            (e) => e.statusCode == 409 && e.message.contains('CHECKPOINT_CONFLICT'),
          ),
        ),
      );
    });

    test('4. HTTP 410 Gone triggers MockHttpException indicating compaction gap', () async {
      transport.shouldReturn410 = true;

      expect(
        () => transport.getChanges(
          ownerScope: ownerScope,
          afterRevision: '50',
        ),
        throwsA(
          predicate<MockHttpException>(
            (e) => e.statusCode == 410 && e.message.contains('COMPACTION_GAP'),
          ),
        ),
      );
    });

    test('5. Invalid checkpoint triggers MockHttpException HTTP 400', () async {
      transport.shouldReturnInvalidCheckpoint = true;

      expect(
        () => transport.getChanges(
          ownerScope: ownerScope,
          afterRevision: 'invalid-rev!',
        ),
        throwsA(
          predicate<MockHttpException>(
            (e) => e.statusCode == 400 && e.message.contains('MANDATORY_OCC_CHECKPOINT_REQUIRED'),
          ),
        ),
      );
    });

    test('6. Snapshot bootstrap interruption throws midway simulation exception', () async {
      transport.shouldInterruptSnapshotMidway = true;

      expect(
        () => transport.getSnapshot(
          ownerScope: ownerScope,
          cursor: 'cursor-page-2',
        ),
        throwsA(
          predicate<MockNetworkException>(
            (e) => e.message.contains('SNAPSHOT_INTERRUPTED_MIDWAY'),
          ),
        ),
      );
    });

    test('7. Stale server revision returns revision regressed behind client revision', () async {
      transport.shouldReturnStaleRevision = true;
      transport.staleRevisionOverride = '40'; // client yêu cầu afterRevision: 50 nhưng server trả 40

      final page = await transport.getChanges(
        ownerScope: ownerScope,
        afterRevision: '50',
      );

      expect(page.currentServerRevision, '40');
      expect(BigInt.parse(page.currentServerRevision) < BigInt.parse('50'), isTrue);
    });

    test('8. Partial page response returns hasMore: true with partitioned batch', () async {
      transport.customChangesHandler = (scope, afterRev, limit) async {
        return const SyncChangesPage(
          currentServerRevision: '120',
          minActiveRevision: '100',
          nextRevision: '110',
          hasMore: true,
          changes: [
            SyncChangeItem(
              revision: '105',
              domain: 'BOOKMARK',
              entityId: 'story-part-1',
              operation: 'UPSERT',
              payload: {'storyId': 'story-part-1'},
            ),
          ],
        );
      };

      final page = await transport.getChanges(
        ownerScope: ownerScope,
        afterRevision: '100',
        limit: 1,
      );

      expect(page.hasMore, isTrue);
      expect(page.nextRevision, '110');
      expect(page.changes.length, 1);
    });

    test('9. Mid-operation account switch or logout triggers onOperationStart cancellation', () async {
      var switchedUserMidOperation = false;

      transport.onOperationStart = (operation, scope) async {
        if (operation == 'pushMutationsBatch') {
          // Mô phỏng người dùng bấm Logout hoặc đổi tài khoản giữa lúc request đang bắt đầu
          switchedUserMidOperation = true;
          throw const MockNetworkException('SESSION_ABORTED_BY_USER_SWITCH');
        }
      };

      expect(
        () => transport.pushMutationsBatch(
          ownerScope: ownerScope,
          mutations: const [],
        ),
        throwsA(
          predicate<MockNetworkException>(
            (e) => e.message == 'SESSION_ABORTED_BY_USER_SWITCH',
          ),
        ),
      );

      expect(switchedUserMidOperation, isTrue);
    });
  });
}
