import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
  OneToOne,
  JoinColumn,
  ManyToOne,
} from 'typeorm';
import { User } from './user.entity';
import { RankTheme } from './rank-theme.entity';

@Entity('user_progression')
export class UserProgression {
  @PrimaryColumn('uuid', { name: 'user_id' })
  userId: string;

  @Column({ default: 1 })
  level: number;

  @Column({ name: 'total_exp', type: 'bigint', default: 0 })
  totalExp: string;

  @Column({ name: 'omnicoin_balance', type: 'bigint', default: 0 })
  omnicoinBalance: string;

  @Column({ name: 'current_streak', default: 0 })
  currentStreak: number;

  @Column({ name: 'max_streak', default: 0 })
  maxStreak: number;

  @Column({ name: 'last_checkin_date', type: 'date', nullable: true })
  lastCheckinDate: string | null;

  @Column({ name: 'rank_theme_id', length: 30, default: 'DEFAULT' })
  rankThemeId: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @OneToOne(() => User, (user) => user.progression, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => RankTheme)
  @JoinColumn({ name: 'rank_theme_id' })
  rankTheme: RankTheme;
}
