import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  OneToOne,
  JoinColumn,
  Check,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { bigintDecimalStringTransformer } from '../transformers/bigint-decimal-string.transformer';

@Entity('user_sync_state')
@Check('chk_sync_revision_monotonic', '"min_active_revision" <= "current_sync_revision"')
export class UserSyncState {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({
    name: 'current_sync_revision',
    type: 'bigint',
    default: '0',
    transformer: bigintDecimalStringTransformer,
  })
  currentSyncRevision: string;

  @Column({
    name: 'min_active_revision',
    type: 'bigint',
    default: '0',
    transformer: bigintDecimalStringTransformer,
  })
  minActiveRevision: string;

  @Column({
    name: 'last_synced_at',
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
    nullable: true,
  })
  lastSyncedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
