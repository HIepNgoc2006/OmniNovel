import {
  IsDefined,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { SyncDomain, SyncOperation } from '../interfaces/sync.types';
import { IsValidBigIntRevision } from '../validators/bigint-revision.validator';

@ValidatorConstraint({ name: 'IsPlainJsonObject', async: false })
export class IsPlainJsonObjectConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown): boolean {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a valid non-null plain JSON object`;
  }
}

export class ClientMutationDto {
  /**
   * Device / local storage replica identifier (UUID v4).
   */
  @IsUUID('4', { message: 'clientId must be a valid UUID v4' })
  clientId: string;

  /**
   * Mutation identifier (UUID v4) for idempotency tracking.
   */
  @IsUUID('4', { message: 'mutationId must be a valid UUID v4' })
  mutationId: string;

  /**
   * Domain of the library entity.
   */
  @IsEnum(SyncDomain, {
    message: 'domain must be one of: BOOKMARK, PROGRESS, HISTORY, PREFERENCE, FOLLOW',
  })
  domain: SyncDomain;

  /**
   * Entity identifier (StoryId, StoryId:ChapterId, or preference key).
   */
  @IsString({ message: 'entityId must be a string' })
  @IsNotEmpty({ message: 'entityId cannot be empty' })
  @MaxLength(128, { message: 'entityId cannot exceed 128 characters' })
  entityId: string;

  /**
   * Mutation operation type.
   */
  @IsEnum(SyncOperation, {
    message: 'operation must be UPSERT or DELETE',
  })
  operation: SyncOperation;

  /**
   * Monotonic base server revision observed by the client.
   * Strictly validated as an unsigned non-negative decimal string bounded to PostgreSQL BIGINT [0..9223372036854775807].
   */
  @IsString({ message: 'baseServerRevision must be a string' })
  @IsValidBigIntRevision({ min: 0n })
  baseServerRevision: string;

  /**
   * Raw payload of the mutation. Must be a plain JSON object.
   */
  @IsDefined({ message: 'payload is required' })
  @Validate(IsPlainJsonObjectConstraint)
  payload: Record<string, unknown>;

  /**
   * Client-side wall-clock timestamp (ISO 8601) for telemetry/observability only.
   * Server strictly enforces logical monotonic ordering.
   */
  @IsOptional()
  @IsISO8601({}, { message: 'clientCreatedAt must be a valid ISO-8601 date string' })
  clientCreatedAt?: string;
}
