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
import { ChapterVersionType } from '@omninovel/shared';
import { Chapter } from './chapter.entity';
import { User } from '../../users/entities/user.entity';
import { MediaAsset } from './media-asset.entity';

@Entity('chapter_versions')
@Unique(['chapterId', 'versionNumber'])
@Unique('uq_chapter_version_pair', ['chapterId', 'id'])
export class ChapterVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'chapter_id', type: 'uuid' })
  chapterId: string;

  @Column({ name: 'version_number', default: 1 })
  versionNumber: number;

  @Column({
    name: 'version_type',
    type: 'varchar',
    length: 30,
  })
  versionType: ChapterVersionType;

  @Column({ length: 10, default: 'vi' })
  language: string;

  @Column({ name: 'source_version_id', type: 'uuid', nullable: true })
  sourceVersionId: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @Column({ name: 'is_published', default: true })
  isPublished: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => Chapter, (chapter) => chapter.versions, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'chapter_id' })
  chapter: Chapter;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by' })
  creatorUser: User;

  @OneToMany(() => MediaAsset, (asset) => asset.chapterVersion)
  mediaAssets: MediaAsset[];
}
