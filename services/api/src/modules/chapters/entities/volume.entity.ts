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
import { Chapter } from './chapter.entity';

@Entity('volumes')
@Unique(['storyEditionId', 'volumeNumber'])
export class Volume {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'story_edition_id', type: 'uuid' })
  storyEditionId: string;

  @Column({ name: 'volume_number' })
  volumeNumber: number;

  @Column({ length: 255 })
  title: string;

  @Column({ name: 'cover_url', length: 255, nullable: true })
  coverUrl: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => StoryEdition, (edition) => edition.volumes, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'story_edition_id' })
  storyEdition: StoryEdition;

  @OneToMany(() => Chapter, (chapter) => chapter.volume)
  chapters: Chapter[];
}
