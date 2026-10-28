import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { bigintDecimalStringTransformer } from '../transformers/bigint-decimal-string.transformer';

@Entity('sync_mutation_receipts')
@Index('idx_sync_mutation_receipts_lookup', [
  'userId',
  'clientId',
  'mutationId',
])
export class SyncMutationReceipt {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @PrimaryColumn({ name: 'client_id', type: 'varchar', length: 64 })
  clientId: string;

  @PrimaryColumn({ name: 'mutation_id', type: 'uuid' })
  mutationId: string;

  @Column({ name: 'payload_hash', type: 'varchar', length: 64 })
  payloadHash: string;

  @Column({ type: 'varchar', length: 32 })
  status: string;

  @Column({
    name: 'assigned_revision',
    type: 'bigint',
    nullable: true,
    transformer: bigintDecimalStringTransformer,
  })
  assignedRevision: string | null;

  @Column({ name: 'response_meta', type: 'jsonb', default: {} })
  responseMeta: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
