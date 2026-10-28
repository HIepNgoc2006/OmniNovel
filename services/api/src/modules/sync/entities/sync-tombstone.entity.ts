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

@Entity('sync_tombstones')
@Index('idx_sync_tombstones_user_rev', ['userId', 'deletedAtRevision'])
export class SyncTombstone {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @PrimaryColumn({ type: 'varchar', length: 32 })
  domain: string;

  @PrimaryColumn({ name: 'entity_id', type: 'varchar', length: 128 })
  entityId: string;

  @Column({
    name: 'deleted_at_revision',
    type: 'bigint',
    transformer: bigintDecimalStringTransformer,
  })
  deletedAtRevision: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
