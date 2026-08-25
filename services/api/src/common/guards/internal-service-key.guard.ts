import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class InternalServiceKeyGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const providedKey =
      (request.headers['x-internal-service-key'] as string) ||
      (request.headers['X-Internal-Service-Key'] as string);

    if (!providedKey) {
      throw new UnauthorizedException(
        'Yêu cầu bị từ chối: Thiếu header xác thực dịch vụ nội bộ X-Internal-Service-Key.',
      );
    }

    const expectedKey = this.configService.get<string>(
      'AI_WORKER_SECRET',
      'internal_ai_worker_secret_secure_2026',
    );

    const providedBuf = Buffer.from(providedKey, 'utf8');
    const expectedBuf = Buffer.from(expectedKey, 'utf8');

    // Chống Timing Attack và chống crash do lệch độ dài byte
    if (providedBuf.length !== expectedBuf.length) {
      throw new UnauthorizedException(
        'Yêu cầu bị từ chối: Khóa xác thực dịch vụ nội bộ không hợp lệ.',
      );
    }

    const isMatch = crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!isMatch) {
      throw new UnauthorizedException(
        'Yêu cầu bị từ chối: Khóa xác thực dịch vụ nội bộ không hợp lệ.',
      );
    }

    return true;
  }
}
