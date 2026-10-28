import {
  Entity,
  PrimaryColumn,
  Generated,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { bigintDecimalStringTransformer } from '../transformers/bigint-decimal-string.transformer';

@Entity('sync_change_log')
@Unique('uq_sync_change_log_user_revision', ['userId', 'revision'])
@Index('idx_sync_change_log_pull', ['userId', 'revision'])
@Index('idx_sync_change_log_gc', ['userId', 'createdAt'])
export class SyncChangeLog {
  @PrimaryColumn({
    type: 'bigint',
    transformer: bigintDecimalStringTransformer,
  })
  @Generated('increment')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({
    type: 'bigint',
    transformer: bigintDecimalStringTransformer,
  })
  revision: string;

  @Column({ name: 'client_id', type: 'varchar', length: 64 })
  clientId: string;

  @Column({ name: 'mutation_id', type: 'uuid' })
  mutationId: string;

  @Column({ type: 'varchar', length: 32 })
  domain: string;

  @Column({ name: 'entity_id', type: 'varchar', length: 128 })
  entityId: string;

  @Column({ type: 'varchar', length: 16 })
  operation: string;

  @Column({ type: 'jsonb', default: {} })
  payload: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
