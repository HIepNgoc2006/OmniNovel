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
import { User } from '../../users/entities/user.entity';
import { TranslationGlossary } from './translation-glossary.entity';
import { TranslationJob } from './translation-job.entity';

@Entity('translation_projects')
@Unique('uq_translation_project_edition_lang', [
  'storyEditionId',
  'sourceLanguage',
  'targetLanguage',
])
export class TranslationProject {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'story_edition_id', type: 'uuid' })
  storyEditionId: string;

  @ManyToOne(() => StoryEdition, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'story_edition_id' })
  storyEdition: StoryEdition;

  @Column({ name: 'source_language', length: 10, default: 'ja' })
  sourceLanguage: string;

  @Column({ name: 'target_language', length: 10, default: 'vi' })
  targetLanguage: string;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by' })
  creator: User | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => TranslationGlossary, (g) => g.project)
  glossaries: TranslationGlossary[];

  @OneToMany(() => TranslationJob, (job) => job.project)
  jobs: TranslationJob[];
}
