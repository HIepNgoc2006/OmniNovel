import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Chapter } from './chapter.entity';
import { ChapterVersion } from './chapter-version.entity';
import { ChapterReportErrorType, ChapterReportStatus } from '@omninovel/shared';

@Entity('chapter_error_reports')
export class ChapterErrorReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'reporter_id', type: 'uuid', nullable: true })
  reporterId: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'reporter_id' })
  reporter?: User;

  @Column({ name: 'chapter_id', type: 'uuid' })
  chapterId: string;

  @ManyToOne(() => Chapter, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'chapter_id' })
  chapter?: Chapter;

  @Column({ name: 'chapter_version_id', type: 'uuid', nullable: true })
  chapterVersionId: string | null;

  @ManyToOne(() => ChapterVersion, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'chapter_version_id' })
  chapterVersion?: ChapterVersion;

  @Column({ name: 'page_number', type: 'int', nullable: true })
  pageNumber: number | null;

  @Column({ name: 'anchor_block_id', type: 'varchar', length: 100, nullable: true })
  anchorBlockId: string | null;

  @Column({ name: 'error_type', type: 'varchar', length: 30 })
  errorType: ChapterReportErrorType;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ type: 'varchar', length: 20, default: ChapterReportStatus.PENDING })
  status: ChapterReportStatus;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'resolved_by' })
  resolver?: User;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
