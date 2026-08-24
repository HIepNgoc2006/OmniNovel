import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

@Entity('level_rewards')
export class LevelReward {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'milestone_level', type: 'int', unique: true })
  milestoneLevel: number;

  @Column({ name: 'reward_coins', type: 'int', default: 0 })
  rewardCoins: number;

  @Column({ name: 'reward_badge_id', length: 50, nullable: true })
  rewardBadgeId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
