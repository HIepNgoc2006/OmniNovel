import { MutationResultItemDto } from './mutation-result-item.dto';

export class PushMutationsBatchResponseDto {
  processedCount: number;
  newServerRevision: string;
  results: MutationResultItemDto[];
}
