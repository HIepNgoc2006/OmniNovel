import { Entity, PrimaryColumn, Column, OneToMany } from 'typeorm';
import { RankLevel } from './rank-level.entity';

@Entity('rank_themes')
export class RankTheme {
  @PrimaryColumn({ length: 30 })
  id: string;

  @Column({ length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @OneToMany(() => RankLevel, (level) => level.theme)
  levels: RankLevel[];
}
