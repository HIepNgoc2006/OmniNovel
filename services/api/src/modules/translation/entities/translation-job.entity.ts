import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Unique,
} from 'typeorm';
import { TranslationJobStatus } from '@omninovel/shared';
import { TranslationProject } from './translation-project.entity';
import { ChapterVersion } from '../../chapters/entities/chapter-version.entity';
import { UploadSession } from '../../storage/entities/upload-session.entity';
import { User } from '../../users/entities/user.entity';
import { TranslationSegment } from './translation-segment.entity';

@Entity('translation_jobs')
@Unique('uq_translation_job_user_idemp', ['createdBy', 'idempotencyKey'])
export class TranslationJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @ManyToOne(() => TranslationProject, (p) => p.jobs, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: TranslationProject;

  @Column({ name: 'source_version_id', type: 'uuid' })
  sourceVersionId: string;

  @ManyToOne(() => ChapterVersion, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'source_version_id' })
  sourceVersion: ChapterVersion;

  @Column({ name: 'target_version_id', type: 'uuid', nullable: true })
  targetVersionId: string | null;

  @ManyToOne(() => ChapterVersion, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'target_version_id' })
  targetVersion: ChapterVersion | null;

  @Column({ name: 'source_upload_session_id', type: 'uuid', nullable: true })
  sourceUploadSessionId: string | null;

  @ManyToOne(() => UploadSession, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'source_upload_session_id' })
  sourceUploadSession: UploadSession | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by' })
  creator: User | null;

  @Column({ name: 'idempotency_key', length: 100, nullable: true })
  idempotencyKey: string | null;

  @Column({ name: 'apply_idempotency_key', length: 100, nullable: true })
  applyIdempotencyKey: string | null;

  @Column({
    type: 'varchar',
    length: 30,
    default: TranslationJobStatus.CREATED,
  })
  status: TranslationJobStatus;

  @Column({ name: 'progress_percentage', default: 0 })
  progressPercentage: number;

  @Column({ name: 'attempt_count', default: 0 })
  attemptCount: number;

  @Column({ name: 'max_attempts', default: 3 })
  maxAttempts: number;

  @Column({ name: 'last_sequence', default: 0 })
  lastSequence: number;

  @Column({ length: 50, default: 'OPENAI' })
  provider: string;

  @Column({ name: 'model_name', length: 50, default: 'gpt-4o-mini' })
  modelName: string;

  @Column({ name: 'prompt_version', length: 20, default: 'v1.0' })
  promptVersion: string;

  @Column({ name: 'result_manifest', type: 'jsonb', nullable: true })
  resultManifest: Record<string, any> | null;

  @Column({ name: 'error_trace', type: 'text', nullable: true })
  errorTrace: string | null;

  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt: Date | null;

  @Column({ name: 'heartbeat_at', type: 'timestamptz', nullable: true })
  heartbeatAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => TranslationSegment, (s) => s.job)
  segments: TranslationSegment[];
}
