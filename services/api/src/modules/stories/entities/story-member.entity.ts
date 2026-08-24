import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { StoryMemberRole } from '@omninovel/shared';
import { Story } from './story.entity';
import { User } from '../../users/entities/user.entity';

@Entity('story_members')
@Unique(['storyId', 'userId'])
export class StoryMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'story_id', type: 'uuid' })
  storyId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({
    type: 'varchar',
    length: 20,
  })
  role: StoryMemberRole;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => Story, (story) => story.members, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'story_id' })
  story: Story;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
