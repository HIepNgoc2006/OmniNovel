import { ProgressMutationPayloadDto } from './mutation-payloads.dto';

export class SnapshotBookmarkItemDto {
  storyId: string;
  createdAt: string;
}

export class SnapshotChapterReadStateItemDto {
  chapterId: string;
  storyId: string;
  chapterVersionId?: string | null;
  maxProgressPercentage: number;
  completedAt: string | null;
  lastReadAt: string;
  storyHistoryEpoch: number;
}

export class SnapshotPreferenceItemDto {
  key: string;
  value: unknown;
  updatedAt: string;
}

export class SnapshotDataDto {
  bookmarks: SnapshotBookmarkItemDto[];
  readingProgress: ProgressMutationPayloadDto[];
  chapterReadStates: SnapshotChapterReadStateItemDto[];
  preferences: SnapshotPreferenceItemDto[];
}

export class SyncSnapshotResponseDto {
  snapshotRevision: string;
  minActiveRevision: string;
  hasMore: boolean;
  nextCursor: string | null;
  data: SnapshotDataDto;
}
