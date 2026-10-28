import { Injectable } from '@nestjs/common';
import { SyncDomain, SyncOperation } from '../interfaces/sync.types';
import {
  ConflictResolutionResult,
  ConflictResolverContext,
  IConflictResolver,
} from './conflict-resolver.interface';

@Injectable()
export class BookmarkConflictResolver implements IConflictResolver {
  readonly domain = SyncDomain.BOOKMARK;

  resolve(context: ConflictResolverContext): ConflictResolutionResult {
    const { mutation, tombstoneRevision } = context;

    if (mutation.operation === SyncOperation.DELETE) {
      return {
        status: 'APPLIED',
        assignedRevision: null,
        message: 'Bookmark marked for deletion',
      };
    }

    // Operation is UPSERT
    // Anti-Resurrection Guard: Check if a tombstone exists with deleted_at_revision >= baseServerRevision
    if (tombstoneRevision !== null && tombstoneRevision !== undefined) {
      const tombstoneRev = BigInt(tombstoneRevision);
      const baseRev = BigInt(mutation.baseServerRevision);

      if (tombstoneRev >= baseRev) {
        return {
          status: 'REJECTED_TOMBSTONE',
          reason: 'TOMBSTONE_CONFLICT',
          message: `Bookmark was deleted at revision ${tombstoneRevision}, which is >= client base revision ${mutation.baseServerRevision}`,
          metadata: {
            tombstoneRevision,
            baseServerRevision: mutation.baseServerRevision,
          },
          assignedRevision: null,
        };
      }
    }

    return {
      status: 'APPLIED',
      assignedRevision: null,
      message: 'Bookmark upsert accepted',
    };
  }
}
