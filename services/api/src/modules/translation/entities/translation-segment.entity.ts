import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { TranslationJob } from './translation-job.entity';

@Entity('translation_segments')
export class TranslationSegment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'job_id', type: 'uuid' })
  jobId: string;

  @ManyToOne(() => TranslationJob, (j) => j.segments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job: TranslationJob;

  @Column({ name: 'page_number', nullable: true })
  pageNumber: number | null;

  @Column({ name: 'anchor_block_id', length: 100, nullable: true })
  anchorBlockId: string | null;

  @Column({ name: 'sort_order' })
  sortOrder: number;

  @Column({ name: 'bbox_x', nullable: true })
  bboxX: number | null;

  @Column({ name: 'bbox_y', nullable: true })
  bboxY: number | null;

  @Column({ name: 'bbox_w', nullable: true })
  bboxW: number | null;

  @Column({ name: 'bbox_h', nullable: true })
  bboxH: number | null;

  @Column({ name: 'raw_text', type: 'text' })
  rawText: string;

  @Column({ name: 'translated_text', type: 'text', nullable: true })
  translatedText: string | null;

  @Column({ type: 'numeric', precision: 4, scale: 3, default: 0.95 })
  confidence: number;

  @Column({ name: 'is_human_verified', default: false })
  isHumanVerified: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
