import { ClientMutationDto } from '../dto/client-mutation.dto';
import {
  MutationExecutionStatus,
  SyncDomain,
} from '../interfaces/sync.types';

export interface ConflictResolverContext {
  userId: string;
  mutation: ClientMutationDto;
  canonicalHash: string;
  serverRevision: string;
  minActiveRevision: string;
  existingRecord?: any;
  tombstoneRevision?: string | null;
  effectiveHistoryEpoch?: number;
}

export interface ConflictResolutionResult {
  status: MutationExecutionStatus;
  assignedRevision: string | null;
  reason?: string;
  message?: string;
  resolvedPayload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface IConflictResolver {
  readonly domain: SyncDomain;
  resolve(
    context: ConflictResolverContext,
  ): Promise<ConflictResolutionResult> | ConflictResolutionResult;
}
