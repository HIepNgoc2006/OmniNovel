import {
  canonicalJsonStringify,
  computeCanonicalMutationHash,
  hasLoneSurrogate,
  validateIJsonDomain,
  ClientMutationDto,
} from './canonical-json.helper';

describe('JCS RFC 8785 & I-JSON Canonical Serializer Helper (Unit Tests)', () => {
  describe('hasLoneSurrogate', () => {
    it('should return false for clean ascii and bmp strings', () => {
      expect(hasLoneSurrogate('hello world 123 !@#')).toBe(false);
      expect(hasLoneSurrogate('Tiếng Việt có dấu: Đọc truyện')).toBe(false);
    });

    it('should return false for valid surrogate pairs (emoji and cjk)', () => {
      expect(hasLoneSurrogate('😀')).toBe(false);
      expect(hasLoneSurrogate('Prefix 😀 Suffix 🚀')).toBe(false);
      expect(hasLoneSurrogate('\uD83D\uDE00')).toBe(false); // Grinning face
    });

    it('should return true for isolated high surrogates (lone surrogate)', () => {
      expect(hasLoneSurrogate('\uD800')).toBe(true);
      expect(hasLoneSurrogate('test\uD800test')).toBe(true);
      expect(hasLoneSurrogate('\uD800a')).toBe(true);
    });

    it('should return true for isolated low surrogates (lone surrogate)', () => {
      expect(hasLoneSurrogate('\uDC00')).toBe(true);
      expect(hasLoneSurrogate('test\uDC00test')).toBe(true);
      expect(hasLoneSurrogate('a\uDC00')).toBe(true);
    });
  });

  describe('JCS Conformance: Key Sorting & Determinism (Criterion 1)', () => {
    it('should sort object keys by UTF-16 code unit order recursively', () => {
      const input = {
        z: 1,
        a: 2,
        m: {
          beta: 'b',
          alpha: 'a',
        },
      };

      const serialized = canonicalJsonStringify(input);
      expect(serialized).toBe('{"a":2,"m":{"alpha":"a","beta":"b"},"z":1}');
    });

    it('should preserve nested array order while sorting nested objects inside arrays', () => {
      const input = [
        { y: 2, x: 1 },
        { b: 4, a: 3 },
      ];

      const serialized = canonicalJsonStringify(input);
      expect(serialized).toBe('[{"x":1,"y":2},{"a":3,"b":4}]');
    });
  });

  describe('Idempotency Hash Divergence: SYNC-04 (Criterion 2)', () => {
    const baseMutation: ClientMutationDto = {
      clientId: '550e8400-e29b-41d4-a716-446655440000',
      mutationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      domain: 'PROGRESS',
      entityId: 'story-123',
      operation: 'UPSERT',
      baseServerRevision: '100',
      payload: {},
    };

    it('should produce identical canonical hash for structurally equivalent payloads with different key orders', () => {
      const mut1: ClientMutationDto = {
        ...baseMutation,
        payload: { chapterId: 'chap-1', progressPercentage: 70 },
      };
      const mut2: ClientMutationDto = {
        ...baseMutation,
        payload: { progressPercentage: 70, chapterId: 'chap-1' },
      };

      expect(computeCanonicalMutationHash(mut1)).toBe(
        computeCanonicalMutationHash(mut2),
      );
    });

    it('should produce completely different canonical hash when nested payload diverges', () => {
      const mutA: ClientMutationDto = {
        ...baseMutation,
        payload: { chapterId: 'chap-1', progressPercentage: 70 },
      };
      const mutB: ClientMutationDto = {
        ...baseMutation,
        payload: { chapterId: 'chap-1', progressPercentage: 95 },
      };

      const hashA = computeCanonicalMutationHash(mutA);
      const hashB = computeCanonicalMutationHash(mutB);

      expect(hashA).not.toBe(hashB);
      expect(hashA.length).toBe(64);
      expect(hashB.length).toBe(64);
    });
  });

  describe('Fail-Closed: Undefined Rejection (Criterion 3)', () => {
    it('should reject undefined root', () => {
      expect(() => canonicalJsonStringify(undefined)).toThrow(
        /'undefined' is not valid JSON data/,
      );
    });

    it('should reject undefined in object property', () => {
      const objWithUndefined = { x: 70, y: undefined };
      expect(() => canonicalJsonStringify(objWithUndefined)).toThrow(
        /Undefined property value not allowed at root.y/,
      );
    });

    it('should reject undefined inside array element', () => {
      const arrWithUndefined = [1, undefined, 3];
      expect(() => canonicalJsonStringify(arrWithUndefined)).toThrow(
        /Sparse array or undefined element not allowed at root\[1\]/,
      );
    });
  });

  describe('Fail-Closed: Sparse Array Rejection (Criterion 4)', () => {
    it('should reject sparse arrays with empty holes', () => {
      // eslint-disable-next-line no-sparse-arrays
      const sparse = [1, , 3];
      expect(() => canonicalJsonStringify(sparse)).toThrow(
        /Sparse array or undefined element not allowed/,
      );
    });

    it('should reject empty allocated arrays (new Array(3))', () => {
      const emptyArr = new Array(3);
      expect(() => canonicalJsonStringify(emptyArr)).toThrow(
        /Sparse array or undefined element not allowed/,
      );
    });
  });

  describe('Fail-Closed: Non-Plain Object Rejection (Criterion 5)', () => {
    it('should reject Date objects', () => {
      expect(() => canonicalJsonStringify({ date: new Date() })).toThrow(
        /Unsupported object type 'Date'/,
      );
    });

    it('should reject Map and Set', () => {
      expect(() => canonicalJsonStringify({ m: new Map() })).toThrow(
        /Unsupported object type 'Map'/,
      );
      expect(() => canonicalJsonStringify({ s: new Set() })).toThrow(
        /Unsupported object type 'Set'/,
      );
    });

    it('should reject RegExp and Error', () => {
      expect(() => canonicalJsonStringify({ r: /abc/ })).toThrow(
        /Unsupported object type 'RegExp'/,
      );
      expect(() => canonicalJsonStringify({ e: new Error('fail') })).toThrow(
        /Unsupported object type 'Error'/,
      );
    });

    it('should reject custom class instances', () => {
      class CustomItem {
        value = 42;
      }
      expect(() => canonicalJsonStringify({ c: new CustomItem() })).toThrow(
        /only plain JSON objects are allowed/,
      );
    });

    it('should allow Object.create(null) plain dictionary objects', () => {
      const nullProto = Object.create(null);
      nullProto.key = 'val';
      expect(canonicalJsonStringify(nullProto)).toBe('{"key":"val"}');
    });
  });

  describe('Unicode & Lone Surrogate Rejection (Criterion 6)', () => {
    it('should reject lone surrogate in string values', () => {
      expect(() => canonicalJsonStringify({ title: '\uD800' })).toThrow(
        /Invalid lone surrogate in UTF-16 string at root.title/,
      );
    });

    it('should reject lone surrogate in object keys', () => {
      const badKeyObj = { ['\uD800']: 'value' };
      expect(() => canonicalJsonStringify(badKeyObj)).toThrow(
        /Invalid lone surrogate in object key/,
      );
    });

    it('should accept valid multi-byte unicode and emojis', () => {
      expect(canonicalJsonStringify({ emoji: '🎉', author: 'Nguyễn Văn A' })).toBe(
        '{"author":"Nguyễn Văn A","emoji":"🎉"}',
      );
    });
  });

  describe('Numeric Canonicalization & Disallowed Numbers (Criterion 7)', () => {
    it('should canonicalize negative zero (-0) to 0 per RFC 8785 section 3.2.2.3', () => {
      expect(canonicalJsonStringify(-0)).toBe('0');
      expect(canonicalJsonStringify({ val: -0 })).toBe('{"val":0}');
    });

    it('should reject NaN and Infinity', () => {
      expect(() => canonicalJsonStringify({ n: NaN })).toThrow(
        /Invalid non-finite number/,
      );
      expect(() => canonicalJsonStringify({ inf: Infinity })).toThrow(
        /Invalid non-finite number/,
      );
      expect(() => canonicalJsonStringify({ ninf: -Infinity })).toThrow(
        /Invalid non-finite number/,
      );
    });

    it('should reject native BigInt', () => {
      expect(() => canonicalJsonStringify({ b: BigInt(9007199254740995) })).toThrow(
        /Native bigint not allowed/,
      );
    });

    it('should serialize finite numbers accurately', () => {
      expect(canonicalJsonStringify(0)).toBe('0');
      expect(canonicalJsonStringify(12345)).toBe('12345');
      expect(canonicalJsonStringify(-42.5)).toBe('-42.5');
    });
  });

  describe('Strict Mutation Payload Requirement (Criterion 8)', () => {
    const validBase: ClientMutationDto = {
      clientId: '550e8400-e29b-41d4-a716-446655440000',
      mutationId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      domain: 'PROGRESS',
      entityId: 'story-123',
      operation: 'UPSERT',
      baseServerRevision: '100',
      payload: {},
    };

    it('should reject missing or undefined payload', () => {
      const missingPayload = { ...validBase } as any;
      delete missingPayload.payload;
      expect(() => computeCanonicalMutationHash(missingPayload)).toThrow(
        /Mutation payload must be a valid non-null plain JSON object/,
      );
    });

    it('should reject null payload', () => {
      const nullPayload = { ...validBase, payload: null as any };
      expect(() => computeCanonicalMutationHash(nullPayload)).toThrow(
        /Mutation payload must be a valid non-null plain JSON object; received null/,
      );
    });

    it('should reject array payload', () => {
      const arrPayload = { ...validBase, payload: [1, 2] as any };
      expect(() => computeCanonicalMutationHash(arrPayload)).toThrow(
        /Mutation payload must be a valid non-null plain JSON object/,
      );
    });

    it('should reject primitive payload', () => {
      const strPayload = { ...validBase, payload: 'invalid' as any };
      expect(() => computeCanonicalMutationHash(strPayload)).toThrow(
        /Mutation payload must be a valid non-null plain JSON object/,
      );
    });

    describe('Strict baseServerRevision Decimal String Enforcement (P1-A)', () => {
      it('should reject number types (preventing JS unsafe number truncation)', () => {
        const numRev = { ...validBase, baseServerRevision: 100 as any };
        expect(() => computeCanonicalMutationHash(numRev)).toThrow(
          /baseServerRevision must be an unsigned decimal string; received number/,
        );

        const unsafeNumRev = {
          ...validBase,
          baseServerRevision: 9007199254740993 as any,
        };
        expect(() => computeCanonicalMutationHash(unsafeNumRev)).toThrow(
          /baseServerRevision must be an unsigned decimal string; received number/,
        );
      });

      it('should reject negative revision strings', () => {
        const negRev = { ...validBase, baseServerRevision: '-1' };
        expect(() => computeCanonicalMutationHash(negRev)).toThrow(
          /must be an unsigned non-negative decimal string/,
        );
      });

      it('should reject float or malformed decimal strings and whitespace', () => {
        expect(() =>
          computeCanonicalMutationHash({
            ...validBase,
            baseServerRevision: '12.34',
          }),
        ).toThrow(/must be an unsigned non-negative decimal string/);

        expect(() =>
          computeCanonicalMutationHash({
            ...validBase,
            baseServerRevision: 'abc',
          }),
        ).toThrow(/must be an unsigned non-negative decimal string/);

        expect(() =>
          computeCanonicalMutationHash({
            ...validBase,
            baseServerRevision: '',
          }),
        ).toThrow(/must be an unsigned non-negative decimal string/);

        // Fail-closed whitespace checks (no leading/trailing whitespace allowed)
        expect(() =>
          computeCanonicalMutationHash({
            ...validBase,
            baseServerRevision: ' 100 ',
          }),
        ).toThrow(/must be an unsigned non-negative decimal string/);

        expect(() =>
          computeCanonicalMutationHash({
            ...validBase,
            baseServerRevision: '100 ',
          }),
        ).toThrow(/must be an unsigned non-negative decimal string/);

        expect(() =>
          computeCanonicalMutationHash({
            ...validBase,
            baseServerRevision: ' 100',
          }),
        ).toThrow(/must be an unsigned non-negative decimal string/);
      });

      it('should reject revisions exceeding PostgreSQL BIGINT max (9223372036854775807)', () => {
        expect(() =>
          computeCanonicalMutationHash({
            ...validBase,
            baseServerRevision: '9223372036854775808',
          }),
        ).toThrow(/exceeds PostgreSQL BIGINT max/);

        expect(() =>
          computeCanonicalMutationHash({
            ...validBase,
            baseServerRevision: '999999999999999999999999',
          }),
        ).toThrow(/exceeds PostgreSQL BIGINT max/);
      });

      it('should accept valid non-negative decimal strings within PostgreSQL BIGINT bounds (including > 2^53 - 1)', () => {
        const hash0 = computeCanonicalMutationHash({
          ...validBase,
          baseServerRevision: '0',
        });
        expect(hash0.length).toBe(64);

        const hashLarge = computeCanonicalMutationHash({
          ...validBase,
          baseServerRevision: '9007199254740995', // > 2^53 - 1 (JS safe integer)
        });
        expect(hashLarge.length).toBe(64);
        expect(hash0).not.toBe(hashLarge);

        const hashMaxBigInt = computeCanonicalMutationHash({
          ...validBase,
          baseServerRevision: '9223372036854775807', // 2^63 - 1 (PostgreSQL signed BIGINT max)
        });
        expect(hashMaxBigInt.length).toBe(64);
        expect(hashMaxBigInt).not.toBe(hashLarge);
      });
    });
  });

  describe('Fail-Closed: Cyclic Reference Detection (Criterion 9)', () => {
    it('should reject self-referential cyclic objects', () => {
      const cyclicObj: any = { a: 1 };
      cyclicObj.self = cyclicObj;

      expect(() => canonicalJsonStringify(cyclicObj)).toThrow(
        /Cyclic reference detected at root.self/,
      );
    });

    it('should reject cyclic arrays', () => {
      const cyclicArr: any[] = [1, 2];
      cyclicArr.push(cyclicArr);

      expect(() => canonicalJsonStringify(cyclicArr)).toThrow(
        /Cyclic reference detected at root\[2\]/,
      );
    });
  });
});
