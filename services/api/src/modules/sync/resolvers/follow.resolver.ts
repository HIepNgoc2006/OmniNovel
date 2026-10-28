import { Injectable } from '@nestjs/common';
import { SyncDomain } from '../interfaces/sync.types';
import {
  ConflictResolutionResult,
  ConflictResolverContext,
  IConflictResolver,
} from './conflict-resolver.interface';

@Injectable()
export class FollowConflictResolver implements IConflictResolver {
  readonly domain = SyncDomain.FOLLOW;

  resolve(_context: ConflictResolverContext): ConflictResolutionResult {
    // Quy tắc bắt buộc: FOLLOW trả lỗi DOMAIN_NOT_SUPPORTED rõ ràng;
    // tuyệt đối không dùng REJECTED_STALE cho chức năng chưa tồn tại.
    return {
      status: 'DOMAIN_NOT_SUPPORTED',
      reason: 'FOLLOW_DOMAIN_NOT_SUPPORTED',
      message:
        'FOLLOW domain is not supported in Phase 7C (scheduled for implementation in Phase 7F: Story Following Engine)',
      metadata: {
        domain: SyncDomain.FOLLOW,
        scheduledPhase: 'Phase 7F',
      },
      assignedRevision: null,
    };
  }
}
