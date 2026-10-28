import { Injectable } from '@nestjs/common';
import { SyncDomain } from '../interfaces/sync.types';
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
    const payload = mutation.payload as Record<string, any>;
    const observedEpoch = payload?.observedHistoryEpoch;

    // Strict Equality Check theo đúng tiêu chuẩn Phase 7B
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
