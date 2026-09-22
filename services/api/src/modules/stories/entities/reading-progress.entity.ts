import {
  Entity,
  PrimaryColumn,
  Column,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Story } from './story.entity';
import { Chapter } from '../../chapters/entities/chapter.entity';
import { ChapterVersion } from '../../chapters/entities/chapter-version.entity';

@Entity('reading_progress')
@Index(['userId', 'updatedAt'])
export class ReadingProgress {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @PrimaryColumn({ name: 'story_id', type: 'uuid' })
  storyId: string;

  @Column({ name: 'chapter_id', type: 'uuid' })
  chapterId: string;

  @Column({ name: 'chapter_version_id', type: 'uuid', nullable: true })
  chapterVersionId: string | null;

  @Column({ name: 'reading_mode', type: 'varchar', length: 20, default: 'WEBTOON' })
  readingMode: string;

  @Column({
    name: 'progress_percentage',
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
  })
  progressPercentage: number;

  @Column({
    name: 'scroll_position',
    type: 'numeric',
    precision: 10,
    scale: 2,
    default: 0,
  })
  scrollPosition: number;

  @Column({ name: 'page_index', type: 'int', default: 1 })
  pageIndex: number;

  @Column({ name: 'anchor_block_id', type: 'varchar', length: 100, nullable: true })
  anchorBlockId: string | null;

  @Column({ name: 'text_offset', type: 'int', default: 0 })
  textOffset: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Story, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'story_id' })
  story: Story;

  @ManyToOne(() => Chapter, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'chapter_id' })
  chapter: Chapter;

  @ManyToOne(() => ChapterVersion, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'chapter_version_id' })
  chapterVersion: ChapterVersion | null;
}
