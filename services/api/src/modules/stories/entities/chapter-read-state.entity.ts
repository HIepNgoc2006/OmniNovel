import {
  Entity,
  PrimaryColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Chapter } from '../../chapters/entities/chapter.entity';

@Entity('chapter_read_states')
@Index(['userId', 'lastReadAt'])
export class ChapterReadState {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @PrimaryColumn({ name: 'chapter_id', type: 'uuid' })
  chapterId: string;

  @Column({ name: 'last_version_id', type: 'uuid', nullable: true })
  lastVersionId: string | null;

  @Column({
    name: 'max_progress_percentage',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
  })
  maxProgressPercentage: number;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'last_read_at', type: 'timestamptz', default: () => 'NOW()' })
  lastReadAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Chapter, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'chapter_id' })
  chapter: Chapter;
}
