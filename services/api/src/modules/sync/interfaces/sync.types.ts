export enum SyncDomain {
  BOOKMARK = 'BOOKMARK',
  PROGRESS = 'PROGRESS',
  HISTORY = 'HISTORY',
  PREFERENCE = 'PREFERENCE',
  FOLLOW = 'FOLLOW',
}

export enum SyncOperation {
  UPSERT = 'UPSERT',
  DELETE = 'DELETE',
}

export enum ReadingMode {
  WEBTOON = 'WEBTOON',
  PAGED = 'PAGED',
  NOVEL = 'NOVEL',
}

export type MutationExecutionStatus =
  | 'APPLIED'
  | 'DEDUPLICATED'
  | 'REJECTED_TOMBSTONE'
  | 'CONFLICT_MERGED'
  | 'REJECTED_STALE'
  | 'DOMAIN_NOT_SUPPORTED';

export interface SnapshotCursorPayload {
  v: number;
  uid: string;
  srev: string;
  domain: string;
  key: string;
  exp: number;
}
