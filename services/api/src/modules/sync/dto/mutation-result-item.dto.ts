import { MutationExecutionStatus } from '../interfaces/sync.types';

export class MutationResultItemDto {
  mutationId: string;
  status: MutationExecutionStatus;
  assignedRevision: string | null;
  message?: string;
  reason?: string;
}
