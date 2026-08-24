import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { GlobalRole, StoryMemberRole } from '@omninovel/shared';
import { STORY_ROLES_KEY } from '../decorators/require-story-role.decorator';

@Injectable()
export class StoryMemberGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<StoryMemberRole[]>(
      STORY_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Yêu cầu xác thực tài khoản.');
    }

    // Global Admin có toàn quyền bypass
    if (user.role === GlobalRole.ADMIN) {
      return true;
    }

    const storyId = await this.resolveStoryId(request);

    if (!storyId) {
      throw new NotFoundException('Không thể xác định bộ truyện tương ứng với tài nguyên yêu cầu.');
    }

    const membership = await this.dataSource.query(
      `SELECT role FROM story_members WHERE story_id = $1 AND user_id = $2`,
      [storyId, user.id],
    );

    if (!membership || membership.length === 0) {
      throw new ForbiddenException(
        'Bạn không phải là thành viên quản trị của bộ truyện này (IDOR Blocked).',
      );
    }

    const userStoryRole = membership[0].role as StoryMemberRole;
    const hasPermission = requiredRoles.includes(userStoryRole);

    if (!hasPermission) {
      throw new ForbiddenException(
        `Vai trò '${userStoryRole}' của bạn không đủ quyền thực hiện hành động này. Yêu cầu: ${requiredRoles.join(', ')}.`,
      );
    }

    request.storyId = storyId;
    request.storyRole = userStoryRole;
    return true;
  }

  private async resolveStoryId(request: any): Promise<string | null> {
    const params = request.params || {};
    const body = request.body || {};
    const query = request.query || {};

    // 1. Direct Story ID
    const directStoryId = params.storyId || params.id || body.storyId || query.storyId;
    if (directStoryId && this.isUUID(directStoryId)) {
      // Check if it's a story ID
      const story = await this.dataSource.query(
        `SELECT id FROM stories WHERE id = $1`,
        [directStoryId],
      );
      if (story && story.length > 0) {
        return story[0].id;
      }
    }

    // 2. From Edition ID
    const editionId = params.editionId || body.editionId || query.editionId;
    if (editionId && this.isUUID(editionId)) {
      const edition = await this.dataSource.query(
        `SELECT story_id FROM story_editions WHERE id = $1`,
        [editionId],
      );
      if (edition && edition.length > 0) {
        return edition[0].story_id;
      }
    }

    // 3. From Chapter ID (including generic :id in ChaptersController)
    const chapterId = params.chapterId || params.id || body.chapterId || query.chapterId;
    if (chapterId && this.isUUID(chapterId)) {
      const chapter = await this.dataSource.query(
        `SELECT se.story_id FROM chapters c 
         JOIN story_editions se ON c.story_edition_id = se.id 
         WHERE c.id = $1`,
        [chapterId],
      );
      if (chapter && chapter.length > 0) {
        return chapter[0].story_id;
      }
    }

    // 4. From Volume ID
    const volumeId = params.volumeId || body.volumeId || query.volumeId;
    if (volumeId && this.isUUID(volumeId)) {
      const volume = await this.dataSource.query(
        `SELECT se.story_id FROM volumes v 
         JOIN story_editions se ON v.story_edition_id = se.id 
         WHERE v.id = $1`,
        [volumeId],
      );
      if (volume && volume.length > 0) {
        return volume[0].story_id;
      }
    }

    // 5. From Version ID
    const versionId = params.versionId || body.versionId || query.versionId;
    if (versionId && this.isUUID(versionId)) {
      const version = await this.dataSource.query(
        `SELECT se.story_id FROM chapter_versions cv 
         JOIN chapters c ON cv.chapter_id = c.id 
         JOIN story_editions se ON c.story_edition_id = se.id 
         WHERE cv.id = $1`,
        [versionId],
      );
      if (version && version.length > 0) {
        return version[0].story_id;
      }
    }

    return null;
  }

  private isUUID(str: string): boolean {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
  }
}
