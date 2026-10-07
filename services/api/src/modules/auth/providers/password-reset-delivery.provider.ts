import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IPasswordResetDelivery,
  PasswordResetDeliveryPayload,
} from '../interfaces/password-reset-delivery.interface';

@Injectable()
export class PasswordResetDeliveryProvider implements IPasswordResetDelivery {
  private readonly logger = new Logger(PasswordResetDeliveryProvider.name);

  constructor(private configService: ConfigService) {}

  async sendResetToken(payload: PasswordResetDeliveryPayload): Promise<void> {
    // Ghi log bảo mật và điều hướng URL đặt lại mật khẩu
    this.logger.log(
      `[PasswordResetDelivery] Dispatching password reset email to ${payload.email} for user ${payload.userId}. Reset URL: ${payload.resetUrl} (Expires in ${payload.expiresInSeconds}s)`,
    );
  }
}
