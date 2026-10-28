import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { IsValidBigIntRevision } from '../validators/bigint-revision.validator';

export class SyncChangesQueryDto {
  /**
   * Decimal string cursor indicating the server revision after which changes are fetched.
   * Locked to 'after' per Architecture Gate & Contract (cấm dùng sinceRevision).
   * Strictly bounded to PostgreSQL signed BIGINT range [0..9223372036854775807].
   */
  @IsOptional()
  @IsValidBigIntRevision({ min: 0n })
  after?: string = '0';

  /**
   * Maximum number of delta items to fetch per request (1..500, default 100).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1, { message: 'limit must be at least 1' })
  @Max(500, { message: 'limit cannot exceed 500' })
  limit?: number = 100;
}
