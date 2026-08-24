import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  OneToMany,
  ManyToMany,
  JoinTable,
  JoinColumn,
} from 'typeorm';
import {
  MediaFormat,
  PublicationFormat,
  StoryStatus,
  StoryVisibility,
} from '@omninovel/shared';
import { User } from '../../users/entities/user.entity';
import { Genre } from './genre.entity';
import { StoryMember } from './story-member.entity';
import { StoryEdition } from './story-edition.entity';

@Entity('stories')
export class Story {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  title: string;

  @Column({ length: 255, unique: true })
  slug: string;

  @Column({
    name: 'media_format',
    type: 'varchar',
    length: 20,
  })
  mediaFormat: MediaFormat;

  @Column({
    name: 'publication_format',
    type: 'varchar',
    length: 20,
  })
  publicationFormat: PublicationFormat;

  @Column({ name: 'origin_country', length: 10, default: 'JP' })
  originCountry: string;

  @Column({ name: 'original_language', length: 10, default: 'ja' })
  originalLanguage: string;

  @Column({ name: 'cover_url', length: 255 })
  coverUrl: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: StoryStatus.ONGOING,
  })
  status: StoryStatus;

  @Column({
    type: 'varchar',
    length: 20,
    default: StoryVisibility.PUBLIC,
  })
  visibility: StoryVisibility;

  @Column({ type: 'text', nullable: true })
  summary: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @Column({ name: 'views_count', type: 'bigint', default: 0 })
  viewsCount: string;

  @Column({ name: 'followers_count', default: 0 })
  followersCount: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by' })
  creatorUser: User;

  @ManyToMany(() => Genre)
  @JoinTable({
    name: 'story_genres',
    joinColumn: { name: 'story_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'genre_id', referencedColumnName: 'id' },
  })
  genres: Genre[];

  @OneToMany(() => StoryMember, (member) => member.story)
  members: StoryMember[];

  @OneToMany(() => StoryEdition, (edition) => edition.story)
  editions: StoryEdition[];
}
