import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';

export enum ConflictResolution {
  KEEP_CLOUD = 'KEEP_CLOUD',
  USE_GUEST = 'USE_GUEST',
}

export class CommitGuestClaimDto {
  @IsString({ message: 'expectedStateFingerprint must be a string' })
  @Length(64, 64, {
    message: 'expectedStateFingerprint must be a 64-character SHA-256 hash',
  })
  expectedStateFingerprint: string;

  @IsOptional()
  @IsObject({ message: 'conflictDecisions must be a dictionary of storyId -> decision' })
  conflictDecisions?: Record<string, ConflictResolution>;
}
