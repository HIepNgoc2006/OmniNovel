export interface PasswordResetDeliveryPayload {
  userId: string;
  email: string;
  token: string;
  resetUrl: string;
  expiresInSeconds: number;
}

export interface IPasswordResetDelivery {
  sendResetToken(payload: PasswordResetDeliveryPayload): Promise<void>;
}

export const PASSWORD_RESET_DELIVERY = Symbol('PASSWORD_RESET_DELIVERY');
