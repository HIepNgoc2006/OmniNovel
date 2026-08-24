import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { StoryEdition } from '../../stories/entities/story-edition.entity';
import { ChapterVersion } from '../../chapters/entities/chapter-version.entity';

export enum UploadSessionStatus {
  PENDING = 'PENDING',
  VALIDATING = 'VALIDATING',
  PROMOTED = 'PROMOTED',
  FAILED = 'FAILED',
  EXPIRED = 'EXPIRED',
}

@Entity('upload_sessions')
export class UploadSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'story_edition_id', type: 'uuid' })
  storyEditionId: string;

  @Column({ name: 'chapter_version_id', type: 'uuid', nullable: true })
  chapterVersionId: string | null;

  @Column({ name: 'file_type', length: 50 })
  fileType: string;

  @Column({ name: 'expected_size', type: 'bigint' })
  expectedSize: string;

  @Column({ name: 'quarantine_key', length: 255 })
  quarantineKey: string;

  @Column({ name: 'final_key', length: 255, nullable: true })
  finalKey: string | null;

  @Column({
    type: 'varchar',
    length: 30,
    default: UploadSessionStatus.PENDING,
  })
  status: UploadSessionStatus;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => StoryEdition, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'story_edition_id' })
  storyEdition: StoryEdition;

  @ManyToOne(() => ChapterVersion, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'chapter_version_id' })
  chapterVersion: ChapterVersion | null;
}
