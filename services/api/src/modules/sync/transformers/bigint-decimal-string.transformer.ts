import { ValueTransformer } from 'typeorm';

/**
 * ValueTransformer cho các cột PostgreSQL BIGINT.
 *
 * Mục tiêu kiến trúc:
 * 1. Đảm bảo giá trị luôn được biểu diễn dưới dạng Decimal String trong TypeScript runtime.
 * 2. Ngăn ngừa triệt để lỗi mất độ chính xác (Precision Truncation) của JavaScript
 *    khi số vượt quá Number.MAX_SAFE_INTEGER (2^53 - 1 = 9,007,199,254,740,991).
 * 3. Fail-closed nếu gặp số thực float hoặc số vượt quá MAX_SAFE_INTEGER trước khi chuyển đổi.
 */
export const bigintDecimalStringTransformer: ValueTransformer = {
  to: (value: string | number | bigint | null | undefined): string | null => {
    if (value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(
          `[BigIntTransformer] Cannot serialize non-integer number to BIGINT: ${value}`,
        );
      }
      if (
        value > Number.MAX_SAFE_INTEGER ||
        value < Number.MIN_SAFE_INTEGER
      ) {
        throw new Error(
          `[BigIntTransformer] Number ${value} exceeds safe integer range; pass as decimal string or bigint instead`,
        );
      }
    }

    const str = String(value).trim();
    if (!/^-?\d+$/.test(str)) {
      throw new Error(
        `[BigIntTransformer] Invalid decimal string representation for BIGINT: '${str}'`,
      );
    }

    return str;
  },

  from: (value: string | number | bigint | null | undefined): string | null => {
    if (value === null || value === undefined) {
      return null;
    }
    return String(value).trim();
  },
};
