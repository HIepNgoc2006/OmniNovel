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
import { Story } from './story.entity';
import { Volume } from '../../chapters/entities/volume.entity';
import { Chapter } from '../../chapters/entities/chapter.entity';

@Entity('story_editions')
@Unique(['storyId', 'editionName'])
export class StoryEdition {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'story_id', type: 'uuid' })
  storyId: string;

  @Column({ name: 'edition_name', length: 100 })
  editionName: string;

  @Column({ length: 10, default: 'vi' })
  language: string;

  @Column({ name: 'is_default', default: false })
  isDefault: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => Story, (story) => story.editions, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'story_id' })
  story: Story;

  @OneToMany(() => Volume, (volume) => volume.storyEdition)
  volumes: Volume[];

  @OneToMany(() => Chapter, (chapter) => chapter.storyEdition)
  chapters: Chapter[];
}
