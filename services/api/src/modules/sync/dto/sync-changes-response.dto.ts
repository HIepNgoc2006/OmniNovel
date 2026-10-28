import { SyncDomain, SyncOperation } from '../interfaces/sync.types';

export class SyncChangeItemDto {
  revision: string;
  domain: SyncDomain;
  entityId: string;
  operation: SyncOperation;
  payload: Record<string, unknown>;
  createdAt: string;
}

export class SyncChangesResponseDto {
  currentServerRevision: string;
  minActiveRevision: string;
  nextRevision: string | null;
  hasMore: boolean;
  changes: SyncChangeItemDto[];
}
