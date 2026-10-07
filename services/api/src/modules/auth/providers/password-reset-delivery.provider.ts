import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import {
  IPasswordResetDelivery,
  PasswordResetDeliveryPayload,
} from '../interfaces/password-reset-delivery.interface';

@Injectable()
export class PasswordResetDeliveryProvider implements IPasswordResetDelivery {
  private readonly logger = new Logger(PasswordResetDeliveryProvider.name);
  private transporter: nodemailer.Transporter;

  constructor(private configService: ConfigService) {
    this.initTransporter();
  }

  private initTransporter() {
    const host = this.configService.get<string>('SMTP_HOST', 'localhost');
    const port = Number(this.configService.get<number>('SMTP_PORT', 587));
    const secure = this.configService.get<string>('SMTP_SECURE', 'false') === 'true';
    const user = this.configService.get<string>('SMTP_USER', '');
    const pass = this.configService.get<string>('SMTP_PASS', '');

    const options: any = {
      host,
      port,
      secure,
    };

    if (user && pass) {
      options.auth = { user, pass };
    }

    this.transporter = nodemailer.createTransport(options);
  }

  /**
   * Cho phép thay thế transporter (dành cho unit testing hoặc custom transport adapter)
   */
  setTransporter(transporter: nodemailer.Transporter): void {
    this.transporter = transporter;
  }

  /**
   * Gửi email đặt lại mật khẩu với link an toàn.
   * TUYỆT ĐỐI KHÔNG ghi raw token hoặc reset URL vào logs.
   * Lỗi gửi mail được swallow và ghi log an toàn để đảm bảo Anti-Enumeration Invariant.
   */
  async sendResetToken(payload: PasswordResetDeliveryPayload): Promise<void> {
    const mailFrom = this.configService.get<string>(
      'MAIL_FROM',
      'OmniNovel Security <no-reply@omninovel.com>',
    );

    const expireMinutes = Math.max(1, Math.round(payload.expiresInSeconds / 60));

    const mailOptions = {
      from: mailFrom,
      to: payload.email,
      subject: '[OmniNovel] Yêu cầu đặt lại mật khẩu tài khoản',
      text: [
        'Xin chào,',
        '',
        'Bạn (hoặc ai đó) vừa yêu cầu đặt lại mật khẩu cho tài khoản OmniNovel của bạn.',
        `Vui lòng truy cập đường dẫn sau để đặt lại mật khẩu:`,
        `${payload.resetUrl}`,
        '',
        `Liên kết này có hiệu lực trong ${expireMinutes} phút.`,
        'Nếu bạn không thực hiện yêu cầu này, vui lòng bỏ qua email. Mật khẩu của bạn vẫn an toàn.',
      ].join('\n'),
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 8px;">
          <h2 style="color: #4f46e5; margin-top: 0;">OmniNovel - Đặt lại mật khẩu</h2>
          <p>Xin chào,</p>
          <p>Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản liên kết với địa chỉ email này. Vui lòng bấm vào nút bên dưới để thiết lập mật khẩu mới:</p>
          <p style="text-align: center; margin: 28px 0;">
            <a href="${payload.resetUrl}" style="background-color: #4f46e5; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
              Đặt lại mật khẩu
            </a>
          </p>
          <p style="font-size: 14px; color: #6b7280;">Liên kết này sẽ hết hạn sau <strong>${expireMinutes} phút</strong>.</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;" />
          <p style="font-size: 12px; color: #9ca3af; margin-bottom: 0;">Nếu bạn không yêu cầu hành động này, vui lòng bỏ qua email. Mật khẩu hiện tại của bạn vẫn được bảo mật an toàn.</p>
        </div>
      `,
    };

    try {
      await this.transporter.sendMail(mailOptions);
      // Log an toàn: CHỈ ghi nhận hành động gửi tới userId, TUYỆT ĐỐI KHÔNG ghi token hay reset URL
      this.logger.log(
        `[PasswordResetDelivery] Password reset email successfully dispatched for userId=${payload.userId}`,
      );
    } catch (error: any) {
      // Bắt lỗi để bảo toàn Anti-Enumeration (client luôn nhận generic 200 OK)
      this.logger.error(
        `[PasswordResetDelivery] Failed to dispatch password reset email for userId=${payload.userId}: ${error?.message || error}`,
      );
    }
  }
}
