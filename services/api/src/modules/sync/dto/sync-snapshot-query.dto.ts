import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class SyncSnapshotQueryDto {
  /**
   * Signed HMAC Cursor for pagination across snapshot domains and entities.
   * Encodes { version, userId, snapshotRevision, domain, key, exp }.
   */
  @IsOptional()
  @IsString({ message: 'cursor must be a string' })
  cursor?: string;

  /**
   * Maximum number of snapshot items to fetch per page (1..500, default 200).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'limit must be an integer' })
  @Min(1, { message: 'limit must be at least 1' })
  @Max(500, { message: 'limit cannot exceed 500' })
  limit?: number = 200;
}
