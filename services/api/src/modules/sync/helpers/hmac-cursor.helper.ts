import { createHmac, timingSafeEqual } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { SnapshotCursorPayload } from '../interfaces/sync.types';

export class InvalidCursorException extends BadRequestException {
  constructor(
    public readonly code:
      | 'CURSOR_MALFORMED'
      | 'CURSOR_SIGNATURE_INVALID'
      | 'CURSOR_EXPIRED'
      | 'CURSOR_ACCOUNT_MISMATCH'
      | 'CURSOR_VERSION_MISMATCH'
      | 'CURSOR_INVALID_REVISION',
    message: string,
  ) {
    super({
      statusCode: 400,
      error: 'Bad Request',
      code,
      message,
    });
  }
}

export interface GenerateSnapshotCursorParams {
  userId: string;
  snapshotRevision: string;
  domain: string;
  key: string;
  ttlSeconds?: number;
}

export const MAX_POSTGRES_BIGINT = 9223372036854775807n;
export const ALLOWED_SNAPSHOT_DOMAINS = new Set([
  'BOOKMARK',
  'PROGRESS',
  'CHAPTER_READ_STATE',
  'PREFERENCE',
]);

export class HmacCursorHelper {
  private static readonly CURRENT_VERSION = 1;
  private static readonly DEFAULT_TTL_SECONDS = 900; // 15 minutes

  /**
   * Tạo token HMAC Cursor cho phân trang Snapshot.
   * Ràng buộc: version, userId, snapshotRevision, domain, key, expiry.
   */
  static generateCursor(
    params: GenerateSnapshotCursorParams,
    secret: string,
  ): string {
    if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
      throw new Error('[HmacCursorHelper] Secret is required for HMAC cursor generation');
    }

    if (!params.userId || typeof params.userId !== 'string') {
      throw new Error('[HmacCursorHelper] userId is required and must be a string');
    }

    if (
      !params.snapshotRevision ||
      typeof params.snapshotRevision !== 'string' ||
      !/^\d+$/.test(params.snapshotRevision)
    ) {
      throw new Error(
        `[HmacCursorHelper] snapshotRevision must be an unsigned non-negative decimal string with no whitespace; received '${params.snapshotRevision}'`,
      );
    }

    const srevBigInt = BigInt(params.snapshotRevision);
    if (srevBigInt > MAX_POSTGRES_BIGINT) {
      throw new Error(
        `[HmacCursorHelper] snapshotRevision exceeds PostgreSQL BIGINT max (9223372036854775807); received '${params.snapshotRevision}'`,
      );
    }

    if (
      !params.domain ||
      typeof params.domain !== 'string' ||
      !ALLOWED_SNAPSHOT_DOMAINS.has(params.domain)
    ) {
      throw new Error(
        `[HmacCursorHelper] domain must be one of allowed snapshot domains: ${Array.from(ALLOWED_SNAPSHOT_DOMAINS).join(', ')}; received '${params.domain}'`,
      );
    }

    if (params.key === undefined || params.key === null || typeof params.key !== 'string') {
      throw new Error('[HmacCursorHelper] key is required and must be a string');
    }

    const ttl = params.ttlSeconds ?? this.DEFAULT_TTL_SECONDS;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`[HmacCursorHelper] Invalid TTL: ${ttl}`);
    }

    const exp = Math.floor(Date.now() / 1000) + Math.floor(ttl);

    const payload: SnapshotCursorPayload = {
      v: this.CURRENT_VERSION,
      uid: params.userId,
      srev: params.snapshotRevision,
      domain: params.domain,
      key: params.key,
      exp,
    };

    const payloadJson = JSON.stringify(payload);
    const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
    const signature = createHmac('sha256', secret)
      .update(payloadB64)
      .digest('base64url');

    return `${payloadB64}.${signature}`;
  }

  /**
   * Xác thực và giải mã token HMAC Cursor.
   * Ngăn chặn triệt để dùng cursor giữa 2 tài khoản (CURSOR_ACCOUNT_MISMATCH),
   * chống giả mạo chữ ký (CURSOR_SIGNATURE_INVALID), và từ chối cursor quá hạn (CURSOR_EXPIRED).
   */
  static verifyAndDecodeCursor(
    cursor: string,
    expectedUserId: string,
    secret: string,
  ): SnapshotCursorPayload {
    if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
      throw new Error('[HmacCursorHelper] Secret is required for HMAC cursor verification');
    }

    if (!expectedUserId || typeof expectedUserId !== 'string') {
      throw new Error('[HmacCursorHelper] expectedUserId is required for account boundary validation');
    }

    if (!cursor || typeof cursor !== 'string') {
      throw new InvalidCursorException(
        'CURSOR_MALFORMED',
        'Cursor must be a non-empty string',
      );
    }

    const parts = cursor.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new InvalidCursorException(
        'CURSOR_MALFORMED',
        'Cursor format is malformed; must be in format <payload>.<signature>',
      );
    }

    const [payloadB64, signature] = parts;

    // 1. Kiểm tra chữ ký số HMAC-SHA256 bằng constant-time comparison
    const expectedSignature = createHmac('sha256', secret)
      .update(payloadB64)
      .digest('base64url');

    const sigBuf = Buffer.from(signature, 'utf8');
    const expectedSigBuf = Buffer.from(expectedSignature, 'utf8');

    if (
      sigBuf.length !== expectedSigBuf.length ||
      !timingSafeEqual(sigBuf, expectedSigBuf)
    ) {
      throw new InvalidCursorException(
        'CURSOR_SIGNATURE_INVALID',
        'Cursor signature verification failed or token has been tampered with',
      );
    }

    // 2. Giải mã JSON payload
    let rawPayload: unknown;
    try {
      const decodedJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
      rawPayload = JSON.parse(decodedJson);
    } catch {
      throw new InvalidCursorException(
        'CURSOR_MALFORMED',
        'Failed to parse cursor payload as JSON',
      );
    }

    if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
      throw new InvalidCursorException(
        'CURSOR_MALFORMED',
        'Cursor payload must be a JSON object',
      );
    }

    const payload = rawPayload as Record<string, unknown>;

    // 3. Kiểm tra Version
    if (payload.v !== this.CURRENT_VERSION) {
      throw new InvalidCursorException(
        'CURSOR_VERSION_MISMATCH',
        `Unsupported cursor version: ${payload.v}; expected ${this.CURRENT_VERSION}`,
      );
    }

    // 4. Kiểm tra snapshotRevision decimal string và giới hạn PostgreSQL BIGINT
    if (
      typeof payload.srev !== 'string' ||
      !/^\d+$/.test(payload.srev)
    ) {
      throw new InvalidCursorException(
        'CURSOR_INVALID_REVISION',
        `Invalid snapshotRevision in cursor: '${payload.srev}'; must be an unsigned decimal string`,
      );
    }

    const srevBigInt = BigInt(payload.srev);
    if (srevBigInt > MAX_POSTGRES_BIGINT) {
      throw new InvalidCursorException(
        'CURSOR_INVALID_REVISION',
        `snapshotRevision in cursor exceeds PostgreSQL BIGINT max: '${payload.srev}'`,
      );
    }

    // 5. Kiểm tra domain thuộc whitelist snapshot domains và key hợp lệ
    if (
      typeof payload.domain !== 'string' ||
      !ALLOWED_SNAPSHOT_DOMAINS.has(payload.domain)
    ) {
      throw new InvalidCursorException(
        'CURSOR_MALFORMED',
        `Cursor domain '${payload.domain}' is not in allowed snapshot domains: ${Array.from(ALLOWED_SNAPSHOT_DOMAINS).join(', ')}`,
      );
    }

    if (typeof payload.key !== 'string') {
      throw new InvalidCursorException(
        'CURSOR_MALFORMED',
        'Cursor key must be a string',
      );
    }

    // 6. Kiểm tra Expiry
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) {
      throw new InvalidCursorException(
        'CURSOR_MALFORMED',
        'Cursor exp must be a finite numeric timestamp',
      );
    }

    const currentSec = Math.floor(Date.now() / 1000);
    if (currentSec >= payload.exp) {
      throw new InvalidCursorException(
        'CURSOR_EXPIRED',
        `Cursor has expired at ${new Date(payload.exp * 1000).toISOString()}`,
      );
    }

    // 7. Ràng buộc Ranh giới Tài khoản (Account Boundary Protection)
    if (typeof payload.uid !== 'string' || payload.uid !== expectedUserId) {
      throw new InvalidCursorException(
        'CURSOR_ACCOUNT_MISMATCH',
        'Cross-account cursor detected: cursor does not belong to the authenticated user',
      );
    }

    return {
      v: payload.v as number,
      uid: payload.uid as string,
      srev: payload.srev as string,
      domain: payload.domain as string,
      key: payload.key as string,
      exp: payload.exp as number,
    };
  }
}
