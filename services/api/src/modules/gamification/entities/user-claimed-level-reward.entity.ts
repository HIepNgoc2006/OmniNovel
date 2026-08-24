import {
  Entity,
  PrimaryColumn,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { LevelReward } from './level-reward.entity';

@Entity('user_claimed_level_rewards')
export class UserClaimedLevelReward {
  @PrimaryColumn('uuid', { name: 'user_id' })
  userId: string;

  @PrimaryColumn('int', { name: 'reward_id' })
  rewardId: number;

  @CreateDateColumn({ name: 'claimed_at', type: 'timestamptz' })
  claimedAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => LevelReward, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reward_id' })
  reward: LevelReward;
}
