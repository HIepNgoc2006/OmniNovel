import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum GuestClaimStatusEnum {
  PREPARED = 'PREPARED',
  COMMITTED = 'COMMITTED',
  ABORTED = 'ABORTED',
  EXPIRED = 'EXPIRED',
}

@Entity('guest_claims')
@Index('idx_guest_claims_user_id_status', ['userId', 'status'])
@Index('idx_guest_claims_expires_at', ['expiresAt'], {
  where: "status = 'PREPARED'",
})
export class GuestClaim {
  @PrimaryColumn({ name: 'claim_id', type: 'uuid' })
  claimId: string;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'anonymized_subject_hash', type: 'char', length: 64, nullable: true })
  anonymizedSubjectHash: string | null;

  @Column({ name: 'guest_profile_id', type: 'uuid' })
  guestProfileId: string;

  @Column({ name: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash: string;

  @Column({ name: 'state_fingerprint', type: 'varchar', length: 64 })
  stateFingerprint: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: GuestClaimStatusEnum,
    default: GuestClaimStatusEnum.PREPARED,
  })
  status: GuestClaimStatusEnum;

  @Column({ name: 'preview_data', type: 'jsonb' })
  previewData: any;

  @Column({ name: 'conflict_decisions', type: 'jsonb', nullable: true })
  conflictDecisions: any | null;

  @Column({ name: 'result_summary', type: 'jsonb', nullable: true })
  resultSummary: any | null;

  @Column({ name: 'finalization_data', type: 'jsonb', nullable: true })
  finalizationData: any | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'committed_at', type: 'timestamptz', nullable: true })
  committedAt: Date | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user?: User | null;
}
