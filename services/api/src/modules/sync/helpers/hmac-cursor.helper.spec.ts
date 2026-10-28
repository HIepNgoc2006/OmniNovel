import {
  HmacCursorHelper,
  InvalidCursorException,
} from './hmac-cursor.helper';

describe('HmacCursorHelper', () => {
  const SECRET = 'test-sync-cursor-secret-key-32chars!!';
  const USER_A = '11111111-1111-4111-8111-111111111111';
  const USER_B = '22222222-2222-4222-8222-222222222222';
  const SNAPSHOT_REV = '9007199254740995'; // > 2^53 - 1

  describe('generateCursor and verifyAndDecodeCursor', () => {
    it('should generate a valid HMAC cursor and verify it successfully for the same user', () => {
      const cursor = HmacCursorHelper.generateCursor(
        {
          userId: USER_A,
          snapshotRevision: SNAPSHOT_REV,
          domain: 'PROGRESS',
          key: 'story-123:chapter-456',
          ttlSeconds: 600,
        },
        SECRET,
      );

      expect(typeof cursor).toBe('string');
      expect(cursor).toContain('.');

      const decoded = HmacCursorHelper.verifyAndDecodeCursor(
        cursor,
        USER_A,
        SECRET,
      );

      expect(decoded.v).toBe(1);
      expect(decoded.uid).toBe(USER_A);
      expect(decoded.srev).toBe(SNAPSHOT_REV);
      expect(decoded.domain).toBe('PROGRESS');
      expect(decoded.key).toBe('story-123:chapter-456');
      expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it('should reject cursor when presented by a different user (CURSOR_ACCOUNT_MISMATCH)', () => {
      // User A generates cursor
      const cursor = HmacCursorHelper.generateCursor(
        {
          userId: USER_A,
          snapshotRevision: '100',
          domain: 'BOOKMARK',
          key: 'offset-bookmark-50',
        },
        SECRET,
      );

      // User B attempts to use User A's cursor
      expect(() =>
        HmacCursorHelper.verifyAndDecodeCursor(cursor, USER_B, SECRET),
      ).toThrow(InvalidCursorException);

      try {
        HmacCursorHelper.verifyAndDecodeCursor(cursor, USER_B, SECRET);
      } catch (err: any) {
        expect(err.code).toBe('CURSOR_ACCOUNT_MISMATCH');
        expect(err.message).toContain('Cross-account cursor detected');
      }
    });

    it('should reject expired cursor (CURSOR_EXPIRED)', async () => {
      // Create cursor with 1 second TTL
      const cursor = HmacCursorHelper.generateCursor(
        {
          userId: USER_A,
          snapshotRevision: '100',
          domain: 'BOOKMARK',
          key: 'offset-5',
          ttlSeconds: 1,
        },
        SECRET,
      );

      // Wait 1.5s for expiration past the second boundary
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(() =>
        HmacCursorHelper.verifyAndDecodeCursor(cursor, USER_A, SECRET),
      ).toThrow(InvalidCursorException);

      try {
        HmacCursorHelper.verifyAndDecodeCursor(cursor, USER_A, SECRET);
      } catch (err: any) {
        expect(err.code).toBe('CURSOR_EXPIRED');
      }
    });

    it('should reject tampered payload (CURSOR_SIGNATURE_INVALID)', () => {
      const cursor = HmacCursorHelper.generateCursor(
        {
          userId: USER_A,
          snapshotRevision: '100',
          domain: 'BOOKMARK',
          key: 'offset-10',
        },
        SECRET,
      );

      const [payloadB64, sig] = cursor.split('.');
      // Tamper payload to impersonate User B
      const decodedJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
      const tamperedObj = JSON.parse(decodedJson);
      tamperedObj.uid = USER_B;
      const tamperedB64 = Buffer.from(
        JSON.stringify(tamperedObj),
        'utf8',
      ).toString('base64url');

      const tamperedCursor = `${tamperedB64}.${sig}`;

      expect(() =>
        HmacCursorHelper.verifyAndDecodeCursor(tamperedCursor, USER_B, SECRET),
      ).toThrow(InvalidCursorException);

      try {
        HmacCursorHelper.verifyAndDecodeCursor(tamperedCursor, USER_B, SECRET);
      } catch (err: any) {
        expect(err.code).toBe('CURSOR_SIGNATURE_INVALID');
      }
    });

    it('should reject tampered signature (CURSOR_SIGNATURE_INVALID)', () => {
      const cursor = HmacCursorHelper.generateCursor(
        {
          userId: USER_A,
          snapshotRevision: '100',
          domain: 'BOOKMARK',
          key: 'offset-10',
        },
        SECRET,
      );

      const [payloadB64, sig] = cursor.split('.');
      const alteredSig =
        sig.slice(0, -2) + (sig.endsWith('a') ? 'b' : 'a') + sig.slice(-1);

      expect(() =>
        HmacCursorHelper.verifyAndDecodeCursor(
          `${payloadB64}.${alteredSig}`,
          USER_A,
          SECRET,
        ),
      ).toThrow(InvalidCursorException);

      try {
        HmacCursorHelper.verifyAndDecodeCursor(
          `${payloadB64}.${alteredSig}`,
          USER_A,
          SECRET,
        );
      } catch (err: any) {
        expect(err.code).toBe('CURSOR_SIGNATURE_INVALID');
      }
    });

    it('should reject cursor signed with a different secret (CURSOR_SIGNATURE_INVALID)', () => {
      const cursor = HmacCursorHelper.generateCursor(
        {
          userId: USER_A,
          snapshotRevision: '100',
          domain: 'BOOKMARK',
          key: 'offset-10',
        },
        'wrong-secret-key-32chars-long!!',
      );

      expect(() =>
        HmacCursorHelper.verifyAndDecodeCursor(cursor, USER_A, SECRET),
      ).toThrow(InvalidCursorException);

      try {
        HmacCursorHelper.verifyAndDecodeCursor(cursor, USER_A, SECRET);
      } catch (err: any) {
        expect(err.code).toBe('CURSOR_SIGNATURE_INVALID');
      }
    });

    it('should reject malformed cursor strings (CURSOR_MALFORMED)', () => {
      const malformedCases = [
        '',
        'noparts',
        'one.two.three',
        '.sigonly',
        'payloadonly.',
        'invalidbase64url!@#$.sig',
      ];

      for (const badCursor of malformedCases) {
        expect(() =>
          HmacCursorHelper.verifyAndDecodeCursor(badCursor, USER_A, SECRET),
        ).toThrow(InvalidCursorException);
      }
    });

    it('should reject unsupported version (CURSOR_VERSION_MISMATCH)', () => {
      // Craft token with v: 2
      const payload = {
        v: 2,
        uid: USER_A,
        srev: '100',
        domain: 'BOOKMARK',
        key: 'k',
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const crypto = require('crypto');
      const sig = crypto
        .createHmac('sha256', SECRET)
        .update(b64)
        .digest('base64url');

      expect(() =>
        HmacCursorHelper.verifyAndDecodeCursor(`${b64}.${sig}`, USER_A, SECRET),
      ).toThrow(InvalidCursorException);

      try {
        HmacCursorHelper.verifyAndDecodeCursor(`${b64}.${sig}`, USER_A, SECRET);
      } catch (err: any) {
        expect(err.code).toBe('CURSOR_VERSION_MISMATCH');
      }
    });

    it('should reject invalid non-decimal revision format in cursor (CURSOR_INVALID_REVISION)', () => {
      const payload = {
        v: 1,
        uid: USER_A,
        srev: 'rev-abc-123',
        domain: 'BOOKMARK',
        key: 'k',
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const crypto = require('crypto');
      const sig = crypto
        .createHmac('sha256', SECRET)
        .update(b64)
        .digest('base64url');

      expect(() =>
        HmacCursorHelper.verifyAndDecodeCursor(`${b64}.${sig}`, USER_A, SECRET),
      ).toThrow(InvalidCursorException);

      try {
        HmacCursorHelper.verifyAndDecodeCursor(`${b64}.${sig}`, USER_A, SECRET);
      } catch (err: any) {
        expect(err.code).toBe('CURSOR_INVALID_REVISION');
      }
    });

    it('should reject snapshot revision exceeding PostgreSQL BIGINT max in cursor (CURSOR_INVALID_REVISION)', () => {
      const payload = {
        v: 1,
        uid: USER_A,
        srev: '9223372036854775808', // Exceeds signed BIGINT max
        domain: 'BOOKMARK',
        key: 'k',
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const crypto = require('crypto');
      const sig = crypto
        .createHmac('sha256', SECRET)
        .update(b64)
        .digest('base64url');

      expect(() =>
        HmacCursorHelper.verifyAndDecodeCursor(`${b64}.${sig}`, USER_A, SECRET),
      ).toThrow(InvalidCursorException);

      try {
        HmacCursorHelper.verifyAndDecodeCursor(`${b64}.${sig}`, USER_A, SECRET);
      } catch (err: any) {
        expect(err.code).toBe('CURSOR_INVALID_REVISION');
        expect(err.message).toContain('exceeds PostgreSQL BIGINT max');
      }
    });

    it('should reject cursor with disallowed snapshot domain (e.g. FOLLOW)', () => {
      const payload = {
        v: 1,
        uid: USER_A,
        srev: '100',
        domain: 'FOLLOW', // Disallowed in snapshot pagination
        key: 'k',
        exp: Math.floor(Date.now() / 1000) + 600,
      };
      const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const crypto = require('crypto');
      const sig = crypto
        .createHmac('sha256', SECRET)
        .update(b64)
        .digest('base64url');

      expect(() =>
        HmacCursorHelper.verifyAndDecodeCursor(`${b64}.${sig}`, USER_A, SECRET),
      ).toThrow(InvalidCursorException);

      try {
        HmacCursorHelper.verifyAndDecodeCursor(`${b64}.${sig}`, USER_A, SECRET);
      } catch (err: any) {
        expect(err.code).toBe('CURSOR_MALFORMED');
        expect(err.message).toContain('not in allowed snapshot domains');
      }
    });

    it('should preserve and verify snapshot revision at PostgreSQL BIGINT max (9223372036854775807)', () => {
      const MAX_REV = '9223372036854775807';
      const cursor = HmacCursorHelper.generateCursor(
        {
          userId: USER_A,
          snapshotRevision: MAX_REV,
          domain: 'CHAPTER_READ_STATE',
          key: 'last-read-item',
        },
        SECRET,
      );

      const decoded = HmacCursorHelper.verifyAndDecodeCursor(
        cursor,
        USER_A,
        SECRET,
      );
      expect(decoded.srev).toBe(MAX_REV);
    });

    it('should fail-closed if secret or parameters are missing during generation', () => {
      expect(() =>
        HmacCursorHelper.generateCursor(
          {
            userId: USER_A,
            snapshotRevision: '100',
            domain: 'BOOKMARK',
            key: 'k',
          },
          '',
        ),
      ).toThrow('[HmacCursorHelper] Secret is required');

      expect(() =>
        HmacCursorHelper.generateCursor(
          {
            userId: '',
            snapshotRevision: '100',
            domain: 'BOOKMARK',
            key: 'k',
          },
          SECRET,
        ),
      ).toThrow('[HmacCursorHelper] userId is required');

      expect(() =>
        HmacCursorHelper.generateCursor(
          {
            userId: USER_A,
            snapshotRevision: 'not-a-number',
            domain: 'BOOKMARK',
            key: 'k',
          },
          SECRET,
        ),
      ).toThrow('snapshotRevision must be an unsigned non-negative decimal string');
    });
  });
});
