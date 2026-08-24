import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GlobalRole, StoryMemberRole } from '@omninovel/shared';
import { STORY_ROLES_KEY } from '../decorators/require-story-role.decorator';
import { StoryMember } from '../../modules/stories/entities/story-member.entity';

@Injectable()
export class StoryMemberGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @InjectRepository(StoryMember)
    private storyMemberRepository: Repository<StoryMember>,
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

    const storyId =
      request.params?.id ||
      request.params?.storyId ||
      request.body?.storyId ||
      request.query?.storyId;

    if (!storyId) {
      throw new NotFoundException('Không tìm thấy định danh bộ truyện (storyId).');
    }

    const membership = await this.storyMemberRepository.findOne({
      where: { storyId, userId: user.id },
    });

    if (!membership) {
      throw new ForbiddenException('Bạn không phải là thành viên quản trị của bộ truyện này.');
    }

    const hasPermission = requiredRoles.includes(membership.role);
    if (!hasPermission) {
      throw new ForbiddenException(
        `Vai trò '${membership.role}' của bạn không đủ quyền thực hiện hành động này. Yêu cầu: ${requiredRoles.join(', ')}.`,
      );
    }

    // Gắn thông tin member vào request để controller có thể sử dụng
    request.storyMembership = membership;
    return true;
  }
}
