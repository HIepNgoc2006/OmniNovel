import { SetMetadata } from '@nestjs/common';
import { StoryMemberRole } from '@omninovel/shared';

export const STORY_ROLES_KEY = 'story_roles';
export const RequireStoryRole = (...roles: StoryMemberRole[]) =>
  SetMetadata(STORY_ROLES_KEY, roles);
