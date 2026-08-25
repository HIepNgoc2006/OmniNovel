import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { TranslationProject } from './translation-project.entity';

@Entity('translation_glossaries')
@Unique(['projectId', 'sourceTerm'])
export class TranslationGlossary {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'project_id', type: 'uuid' })
  projectId: string;

  @ManyToOne(() => TranslationProject, (p) => p.glossaries, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: TranslationProject;

  @Column({ name: 'source_term', length: 100 })
  sourceTerm: string;

  @Column({ name: 'target_term', length: 100 })
  targetTerm: string;

  @Column({ length: 50, default: 'CHARACTER_NAME' })
  category: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
