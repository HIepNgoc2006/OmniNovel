import { Injectable } from '@nestjs/common';
import { SyncDomain, SyncOperation } from '../interfaces/sync.types';
import {
  ConflictResolutionResult,
  ConflictResolverContext,
  IConflictResolver,
} from './conflict-resolver.interface';

@Injectable()
export class HistoryConflictResolver implements IConflictResolver {
  readonly domain = SyncDomain.HISTORY;

  resolve(context: ConflictResolverContext): ConflictResolutionResult {
    const { mutation, effectiveHistoryEpoch = 0 } = context;

    // HISTORY DELETE: Thao tác xóa lịch sử hợp lệ không bắt buộc observedHistoryEpoch.
    // Server sẽ tăng epoch và ghi nhận tombstone độc lập trong transaction của SyncService.
    if (mutation.operation === SyncOperation.DELETE) {
      return {
        status: 'APPLIED',
        assignedRevision: null,
        message: 'History deletion accepted for tombstone and epoch increment',
      };
    }

    const payload = mutation.payload as Record<string, any>;
    const observedEpoch = payload?.observedHistoryEpoch;

    // Strict Equality Check cho HISTORY UPSERT theo đúng tiêu chuẩn Phase 7B
    if (
      observedEpoch === undefined ||
      observedEpoch === null ||
      !Number.isInteger(observedEpoch) ||
      observedEpoch !== effectiveHistoryEpoch
    ) {
      return {
        status: 'REJECTED_TOMBSTONE',
        reason: 'STALE_HISTORY_EPOCH',
        message: `Stale history epoch: observedHistoryEpoch (${observedEpoch}) !== effectiveEpoch (${effectiveHistoryEpoch})`,
        metadata: {
          observedEpoch,
          effectiveEpoch: effectiveHistoryEpoch,
        },
        assignedRevision: null,
      };
    }

    return {
      status: 'APPLIED',
      assignedRevision: null,
      message: 'History progress update accepted with matching epoch',
    };
  }
}
