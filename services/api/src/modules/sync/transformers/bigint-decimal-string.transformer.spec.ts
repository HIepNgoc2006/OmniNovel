import { bigintDecimalStringTransformer } from './bigint-decimal-string.transformer';

describe('BigIntDecimalString ValueTransformer (Unit Tests)', () => {
  describe('to (Database serialization)', () => {
    it('should return null for null or undefined input', () => {
      expect(bigintDecimalStringTransformer.to(null)).toBeNull();
      expect(bigintDecimalStringTransformer.to(undefined)).toBeNull();
    });

    it('should serialize valid decimal strings directly', () => {
      expect(bigintDecimalStringTransformer.to('0')).toBe('0');
      expect(bigintDecimalStringTransformer.to('10425')).toBe('10425');
      expect(bigintDecimalStringTransformer.to('-42')).toBe('-42');
      // 64-bit integer > 2^53 - 1
      expect(bigintDecimalStringTransformer.to('9007199254740995')).toBe(
        '9007199254740995',
      );
    });

    it('should serialize safe numbers to string', () => {
      expect(bigintDecimalStringTransformer.to(0)).toBe('0');
      expect(bigintDecimalStringTransformer.to(100)).toBe('100');
      expect(bigintDecimalStringTransformer.to(Number.MAX_SAFE_INTEGER)).toBe(
        '9007199254740991',
      );
    });

    it('should reject non-integer numbers (floats)', () => {
      expect(() => bigintDecimalStringTransformer.to(10.5)).toThrow(
        /Cannot serialize non-integer number to BIGINT/,
      );
      expect(() => bigintDecimalStringTransformer.to(NaN)).toThrow(
        /Cannot serialize non-integer number to BIGINT/,
      );
      expect(() => bigintDecimalStringTransformer.to(Infinity)).toThrow(
        /Cannot serialize non-integer number to BIGINT/,
      );
    });

    it('should reject numbers exceeding MAX_SAFE_INTEGER to prevent silent precision loss', () => {
      // 9007199254740992 and beyond lose precision in JS Number
      const unsafeNum = Number.MAX_SAFE_INTEGER + 10;
      expect(() => bigintDecimalStringTransformer.to(unsafeNum)).toThrow(
        /exceeds safe integer range; pass as decimal string or bigint instead/,
      );
    });

    it('should serialize native bigint correctly', () => {
      expect(bigintDecimalStringTransformer.to(BigInt('9007199254740995'))).toBe(
        '9007199254740995',
      );
    });

    it('should reject invalid non-numeric strings', () => {
      expect(() => bigintDecimalStringTransformer.to('abc')).toThrow(
        /Invalid decimal string representation for BIGINT/,
      );
      expect(() => bigintDecimalStringTransformer.to('12.34')).toThrow(
        /Invalid decimal string representation for BIGINT/,
      );
    });
  });

  describe('from (Database deserialization)', () => {
    it('should return null for null or undefined', () => {
      expect(bigintDecimalStringTransformer.from(null)).toBeNull();
      expect(bigintDecimalStringTransformer.from(undefined)).toBeNull();
    });

    it('should preserve 64-bit precision as Decimal String without truncation', () => {
      const largeRev = '9007199254740995';
      const result = bigintDecimalStringTransformer.from(largeRev);
      expect(result).toBe('9007199254740995');
      expect(typeof result).toBe('string');
    });

    it('should convert raw numbers from database driver to string', () => {
      expect(bigintDecimalStringTransformer.from(42)).toBe('42');
    });

    it('should convert raw bigint from database driver to string', () => {
      expect(bigintDecimalStringTransformer.from(BigInt(100))).toBe('100');
    });

    it('should reject non-integer numbers from database driver fail-closed', () => {
      expect(() => bigintDecimalStringTransformer.from(10.5)).toThrow(
        /Cannot deserialize non-integer number from BIGINT/,
      );
      expect(() => bigintDecimalStringTransformer.from(NaN)).toThrow(
        /Cannot deserialize non-integer number from BIGINT/,
      );
      expect(() => bigintDecimalStringTransformer.from(Infinity)).toThrow(
        /Cannot deserialize non-integer number from BIGINT/,
      );
    });

    it('should reject numbers exceeding MAX_SAFE_INTEGER in from() to guard against precision loss (P1-B)', () => {
      const unsafeNum = Number.MAX_SAFE_INTEGER + 10;
      expect(() => bigintDecimalStringTransformer.from(unsafeNum)).toThrow(
        /Deserialized number .* exceeds safe integer range; precision may have been compromised/,
      );
    });

    it('should reject invalid decimal strings from database driver fail-closed', () => {
      expect(() => bigintDecimalStringTransformer.from('abc')).toThrow(
        /Invalid decimal string representation from BIGINT column/,
      );
      expect(() => bigintDecimalStringTransformer.from('12.34')).toThrow(
        /Invalid decimal string representation from BIGINT column/,
      );
    });
  });
});
