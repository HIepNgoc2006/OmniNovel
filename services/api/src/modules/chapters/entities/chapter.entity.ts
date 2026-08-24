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
import { StoryEdition } from '../../stories/entities/story-edition.entity';
import { Volume } from './volume.entity';
import { ChapterVersion } from './chapter-version.entity';

@Entity('chapters')
@Unique(['storyEditionId', 'chapterNumber'])
export class Chapter {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'story_edition_id', type: 'uuid' })
  storyEditionId: string;

  @Column({ name: 'volume_id', type: 'uuid', nullable: true })
  volumeId: string | null;

  @Column({ name: 'chapter_number', type: 'numeric', precision: 6, scale: 2 })
  chapterNumber: string;

  @Column({ length: 255, nullable: true })
  title: string | null;

  @Column({ name: 'active_version_id', type: 'uuid', nullable: true })
  activeVersionId: string | null;

  @Column({ name: 'views_count', type: 'bigint', default: 0 })
  viewsCount: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => StoryEdition, (edition) => edition.chapters, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'story_edition_id' })
  storyEdition: StoryEdition;

  @ManyToOne(() => Volume, (volume) => volume.chapters, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({ name: 'volume_id' })
  volume: Volume | null;

  @ManyToOne(() => ChapterVersion, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'active_version_id' })
  activeVersion: ChapterVersion | null;

  @OneToMany(() => ChapterVersion, (version) => version.chapter)
  versions: ChapterVersion[];
}
