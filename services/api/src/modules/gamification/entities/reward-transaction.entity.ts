import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum RewardType {
  EXP = 'EXP',
  OMNICOIN = 'OMNICOIN',
}

export enum RewardSourceType {
  CHECKIN = 'CHECKIN',
  READ_CHAPTER = 'READ_CHAPTER',
  LEVEL_REWARD = 'LEVEL_REWARD',
  MISSION_DAILY = 'MISSION_DAILY',
  ADMIN_ADJUSTMENT = 'ADMIN_ADJUSTMENT',
}

@Entity('reward_transactions')
@Index('idx_reward_transactions_user', ['userId', 'createdAt'])
export class RewardTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid', { name: 'user_id', nullable: true })
  userId: string | null;

  @Column({ name: 'anonymized_subject_hash', type: 'char', length: 64, nullable: true })
  anonymizedSubjectHash: string | null;

  @Column({ name: 'reward_type', length: 20 })
  rewardType: RewardType;

  @Column({ type: 'int' })
  amount: number;

  @Column({ name: 'balance_after', type: 'bigint' })
  balanceAfter: string;

  @Column({ name: 'source_type', length: 50 })
  sourceType: RewardSourceType;

  @Column({ name: 'source_id', length: 100, nullable: true })
  sourceId: string | null;

  @Column({ name: 'idempotency_key', length: 150, unique: true })
  idempotencyKey: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: User | null;
}
