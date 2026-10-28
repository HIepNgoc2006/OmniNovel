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
  validateSync,
} from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SyncDomain, SyncOperation } from '../interfaces/sync.types';
import { IsValidBigIntRevision } from '../validators/bigint-revision.validator';
import {
  BookmarkMutationPayloadDto,
  ProgressMutationPayloadDto,
  HistoryMutationPayloadDto,
  PreferenceMutationPayloadDto,
} from './mutation-payloads.dto';

const UUID_ANY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

@ValidatorConstraint({ name: 'IsValidMutationPayloadAndEntity', async: false })
export class IsValidMutationPayloadAndEntityConstraint
  implements ValidatorConstraintInterface
{
  private failureReason = '';

  validate(payload: Record<string, unknown>, args: ValidationArguments): boolean {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      this.failureReason = 'payload must be a valid non-null plain JSON object';
      return false;
    }

    const dto = args.object as ClientMutationDto;
    if (!dto.domain || !dto.operation) {
      return true;
    }

    const { domain, operation, entityId } = dto;

    if (domain === SyncDomain.BOOKMARK) {
      if (!UUID_ANY_REGEX.test(entityId)) {
        this.failureReason = `BOOKMARK entityId must be a valid UUID; received '${entityId}'`;
        return false;
      }
      if (operation === SyncOperation.UPSERT) {
        const instance = plainToInstance(BookmarkMutationPayloadDto, payload || {});
        const errors = validateSync(instance);
        if (errors.length > 0) {
          this.failureReason = `Invalid BOOKMARK payload: ${errors.map((e) => Object.values(e.constraints || {}).join(', ')).join('; ')}`;
          return false;
        }
        if (instance.storyId !== entityId) {
          this.failureReason = `BOOKMARK entityId ('${entityId}') does not match payload.storyId ('${instance.storyId}')`;
          return false;
        }
      }
      return true;
    }

    if (domain === SyncDomain.PROGRESS) {
      if (!UUID_ANY_REGEX.test(entityId) && !entityId.includes(':')) {
        this.failureReason = `PROGRESS entityId must be a valid UUID or storyId:chapterId; received '${entityId}'`;
        return false;
      }
      if (operation === SyncOperation.UPSERT) {
        const instance = plainToInstance(ProgressMutationPayloadDto, payload || {});
        const errors = validateSync(instance);
        if (errors.length > 0) {
          this.failureReason = `Invalid PROGRESS payload: ${errors.map((e) => Object.values(e.constraints || {}).join(', ')).join('; ')}`;
          return false;
        }
        const expectedStoryId = entityId.includes(':') ? entityId.split(':')[0] : entityId;
        if (instance.storyId !== expectedStoryId) {
          this.failureReason = `PROGRESS entityId ('${entityId}') does not match payload.storyId ('${instance.storyId}')`;
          return false;
        }
      }
      return true;
    }

    if (domain === SyncDomain.HISTORY) {
      if (operation === SyncOperation.UPSERT) {
        const instance = plainToInstance(HistoryMutationPayloadDto, payload || {});
        const errors = validateSync(instance);
        if (errors.length > 0) {
          this.failureReason = `Invalid HISTORY payload: ${errors.map((e) => Object.values(e.constraints || {}).join(', ')).join('; ')}`;
          return false;
        }
        if (entityId !== instance.storyId && entityId !== instance.chapterId) {
          this.failureReason = `HISTORY entityId ('${entityId}') does not match payload.storyId or payload.chapterId`;
          return false;
        }
      } else if (operation === SyncOperation.DELETE) {
        if (
          entityId !== '00000000-0000-0000-0000-000000000000' &&
          entityId !== 'all' &&
          !UUID_ANY_REGEX.test(entityId)
        ) {
          this.failureReason = `HISTORY DELETE entityId must be a valid UUID, global sentinel, or 'all'; received '${entityId}'`;
          return false;
        }
      }
      return true;
    }

    if (domain === SyncDomain.PREFERENCE) {
      if (!entityId || entityId.trim().length === 0) {
        this.failureReason = 'PREFERENCE entityId cannot be empty';
        return false;
      }
      if (operation === SyncOperation.UPSERT) {
        const instance = plainToInstance(PreferenceMutationPayloadDto, payload || {});
        const errors = validateSync(instance);
        if (errors.length > 0) {
          this.failureReason = `Invalid PREFERENCE payload: ${errors.map((e) => Object.values(e.constraints || {}).join(', ')).join('; ')}`;
          return false;
        }
        if (instance.key !== entityId) {
          this.failureReason = `PREFERENCE entityId ('${entityId}') does not match payload.key ('${instance.key}')`;
          return false;
        }
      }
      return true;
    }

    if (domain === SyncDomain.FOLLOW) {
      return true;
    }

    return true;
  }

  defaultMessage(args: ValidationArguments): string {
    return this.failureReason || `${args.property} failed domain payload validation`;
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
   * Raw payload of the mutation. Must be a plain JSON object and match domain schema and entityId.
   */
  @IsDefined({ message: 'payload is required' })
  @Validate(IsPlainJsonObjectConstraint)
  @Validate(IsValidMutationPayloadAndEntityConstraint)
  payload: Record<string, unknown>;

  /**
   * Client-side wall-clock timestamp (ISO 8601) for telemetry/observability only.
   * Server strictly enforces logical monotonic ordering.
   */
  @IsOptional()
  @IsISO8601({}, { message: 'clientCreatedAt must be a valid ISO-8601 date string' })
  clientCreatedAt?: string;
}
