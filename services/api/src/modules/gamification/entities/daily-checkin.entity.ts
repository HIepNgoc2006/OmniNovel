import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('daily_checkins')
@Unique(['userId', 'checkinDate'])
export class DailyCheckin {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid', { name: 'user_id' })
  userId: string;

  @Column({ name: 'checkin_date', type: 'date' })
  checkinDate: string;

  @Column({ name: 'streak_count', type: 'int' })
  streakCount: number;

  @Column({ name: 'reward_coins', type: 'int', default: 5 })
  rewardCoins: number;

  @Column({ name: 'reward_exp', type: 'int', default: 10 })
  rewardExp: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
