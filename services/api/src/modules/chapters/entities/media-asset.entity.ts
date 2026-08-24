import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { MediaAssetType } from '@omninovel/shared';
import { ChapterVersion } from './chapter-version.entity';

@Entity('media_assets')
@Unique(['versionId', 'assetType', 'sortOrder'])
export class MediaAsset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'version_id', type: 'uuid' })
  versionId: string;

  @Column({ name: 'sort_order' })
  sortOrder: number;

  @Column({
    name: 'asset_type',
    type: 'varchar',
    length: 20,
  })
  assetType: MediaAssetType;

  @Column({ name: 'storage_key', length: 255 })
  storageKey: string;

  @Column({ nullable: true })
  width: number;

  @Column({ nullable: true })
  height: number;

  @Column({ name: 'file_size_bytes', type: 'bigint', nullable: true })
  fileSizeBytes: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => ChapterVersion, (version) => version.mediaAssets, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'version_id' })
  chapterVersion: ChapterVersion;
}
