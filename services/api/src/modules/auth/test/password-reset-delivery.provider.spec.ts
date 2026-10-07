import { Logger } from '@nestjs/common';
import { PasswordResetDeliveryProvider } from '../providers/password-reset-delivery.provider';
import { PasswordResetDeliveryPayload } from '../interfaces/password-reset-delivery.interface';

describe('PasswordResetDeliveryProvider (Production Delivery & Zero Credential Exposure)', () => {
  let provider: PasswordResetDeliveryProvider;
  let mockTransporter: any;
  let mockConfigService: any;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const testPayload: PasswordResetDeliveryPayload = {
    userId: 'user-uuid-12345',
    email: 'reader@example.com',
    token: 'super_secret_raw_token_abcdef1234567890',
    resetUrl: 'http://localhost:3000/reset-password?token=super_secret_raw_token_abcdef1234567890',
    expiresInSeconds: 900,
  };

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string, defaultValue?: any) => {
        if (key === 'SMTP_HOST') return 'smtp.example.com';
        if (key === 'SMTP_PORT') return 587;
        if (key === 'MAIL_FROM') return 'OmniNovel Security <no-reply@omninovel.com>';
        return defaultValue;
      }),
    };

    mockTransporter = {
      sendMail: jest.fn().mockResolvedValue({ messageId: 'test-msg-id-123' }),
    };

    provider = new PasswordResetDeliveryProvider(mockConfigService);
    provider.setTransporter(mockTransporter);

    logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('1. should dispatch email via nodemailer transporter with correct recipient, subject and content', async () => {
    await provider.sendResetToken(testPayload);

    expect(mockTransporter.sendMail).toHaveBeenCalledTimes(1);
    const mailArgs = mockTransporter.sendMail.mock.calls[0][0];

    expect(mailArgs.from).toBe('OmniNovel Security <no-reply@omninovel.com>');
    expect(mailArgs.to).toBe(testPayload.email);
    expect(mailArgs.subject).toContain('Yêu cầu đặt lại mật khẩu');
    expect(mailArgs.text).toContain(testPayload.resetUrl);
    expect(mailArgs.html).toContain(testPayload.resetUrl);
    expect(mailArgs.html).toContain('15 phút');
  });

  it('2. should NEVER log raw token or reset URL in application logs (Zero Credential Exposure Invariant)', async () => {
    await provider.sendResetToken(testPayload);

    // Verify all logger calls do NOT contain raw token or reset URL
    const allLogCalls = logSpy.mock.calls.map((call) => call[0]);
    for (const msg of allLogCalls) {
      expect(msg).not.toContain(testPayload.token);
      expect(msg).not.toContain(testPayload.resetUrl);
    }

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`userId=${testPayload.userId}`),
    );
  });

  it('3. should swallow SMTP/delivery errors without throwing, maintaining anti-enumeration protection', async () => {
    mockTransporter.sendMail.mockRejectedValueOnce(new Error('SMTP Connection refused (ETIMEDOUT)'));

    // Must NOT throw exception to caller
    await expect(provider.sendResetToken(testPayload)).resolves.not.toThrow();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const errorMsg = errorSpy.mock.calls[0][0];
    expect(errorMsg).toContain('Failed to dispatch password reset email');
    expect(errorMsg).toContain(testPayload.userId);

    // Error log must also never leak token or resetUrl
    expect(errorMsg).not.toContain(testPayload.token);
    expect(errorMsg).not.toContain(testPayload.resetUrl);
  });
});
