import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { ChapterArtifactType, ChapterArtifactStatus } from '@omninovel/shared';
import { ChapterVersion } from './chapter-version.entity';

@Entity('chapter_artifacts')
@Unique('uq_chapter_version_artifact_type', ['chapterVersionId', 'artifactType'])
export class ChapterArtifact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'chapter_version_id', type: 'uuid' })
  chapterVersionId: string;

  @Column({
    name: 'artifact_type',
    type: 'varchar',
    length: 30,
  })
  artifactType: ChapterArtifactType;

  @Column({
    type: 'varchar',
    length: 20,
    default: ChapterArtifactStatus.MISSING,
  })
  status: ChapterArtifactStatus;

  @Column({ name: 'storage_key', length: 255, nullable: true })
  storageKey: string | null;

  @Column({ name: 'file_size_bytes', type: 'bigint', nullable: true })
  fileSizeBytes: string | null;

  @Column({ name: 'sha256_hash', length: 64, nullable: true })
  sha256Hash: string | null;

  @Column({ name: 'manifest_metadata', type: 'jsonb', nullable: true })
  manifestMetadata: any | null;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(() => ChapterVersion, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'chapter_version_id' })
  chapterVersion: ChapterVersion;
}
