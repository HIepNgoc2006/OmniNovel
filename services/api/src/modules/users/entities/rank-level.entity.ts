import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { RankTheme } from './rank-theme.entity';

@Entity('rank_levels')
@Unique(['themeId', 'minLevel'])
export class RankLevel {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'theme_id', length: 30 })
  themeId: string;

  @Column({ name: 'min_level' })
  minLevel: number;

  @Column({ name: 'max_level' })
  maxLevel: number;

  @Column({ name: 'rank_title', length: 100 })
  rankTitle: string;

  @Column({ name: 'badge_icon', length: 255, nullable: true })
  badgeIcon: string | null;

  @ManyToOne(() => RankTheme, (theme) => theme.levels, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'theme_id' })
  theme: RankTheme;
}
