import { createHash } from 'crypto';

export interface ClientMutationDto {
  clientId: string; // UUIDv4
  mutationId: string; // UUIDv4
  domain: string;
  entityId: string;
  operation: string;
  baseServerRevision: string | number | bigint;
  payload: Record<string, unknown>;
  clientCreatedAt?: string;
}

/**
 * Kiểm tra xem chuỗi có chứa lone surrogate (surrogate pair bị cô lập) hay không.
 * Quét toàn bộ UTF-16 code units: code trong dải [0xD800, 0xDBFF] (High surrogate)
 * bắt buộc phải đi liền với [0xDC00, 0xDFFF] (Low surrogate).
 */
export function hasLoneSurrogate(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= str.length) return true;
      const next = str.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++; // Bỏ qua low surrogate đã ghép cặp hợp lệ
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // Low surrogate đứng đơn lẻ
    }
  }
  return false;
}

/**
 * Kiểm tra tính hợp lệ của dữ liệu theo chuẩn RFC 8785 (JCS) và RFC 7493 (I-JSON).
 * Fail-closed triệt để trước khi hashing: từ chối undefined, lone surrogates,
 * Date, Map, Set, class instances, cyclic references, sparse arrays, NaN, Infinity, native bigint.
 */
export function validateIJsonDomain(
  value: unknown,
  path = 'root',
  seen = new WeakSet(),
): void {
  if (value === undefined) {
    throw new Error(`[JCS] 'undefined' is not valid JSON data at ${path}`);
  }

  if (value === null || typeof value === 'boolean') {
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`[JCS] Invalid non-finite number at ${path}: ${value}`);
    }
    return;
  }

  if (typeof value === 'bigint') {
    throw new Error(
      `[JCS] Native bigint not allowed at ${path}; must be serialized as decimal string`,
    );
  }

  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) {
      throw new Error(
        `[JCS] Invalid lone surrogate in UTF-16 string at ${path}`,
      );
    }
    return;
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`[JCS] Unsupported data type ${typeof value} at ${path}`);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error(`[JCS] Cyclic reference detected at ${path}`);
    }
    seen.add(value);
    for (let i = 0; i < value.length; i++) {
      if (!(i in value) || value[i] === undefined) {
        throw new Error(
          `[JCS] Sparse array or undefined element not allowed at ${path}[${i}]`,
        );
      }
      validateIJsonDomain(value[i], `${path}[${i}]`, seen);
    }
    return;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error(`[JCS] Cyclic reference detected at ${path}`);
    }
    // Chỉ chấp nhận plain JSON objects (từ chối Date, Map, Set, RegExp, custom classes)
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const typeName = Object.prototype.toString.call(value).slice(8, -1);
      throw new Error(
        `[JCS] Unsupported object type '${typeName}' at ${path}; only plain JSON objects are allowed`,
      );
    }
    seen.add(value);

    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    for (const key of keys) {
      // Kiểm tra lone surrogate trên object key
      if (hasLoneSurrogate(key)) {
        throw new Error(
          `[JCS] Invalid lone surrogate in object key at ${path}."${key}"`,
        );
      }
      const propVal = obj[key];
      if (propVal === undefined) {
        throw new Error(
          `[JCS] Undefined property value not allowed at ${path}.${key}`,
        );
      }
      validateIJsonDomain(propVal, `${path}.${key}`, seen);
    }
    return;
  }

  throw new Error(`[JCS] Unsupported data type at ${path}`);
}

/**
 * Serializer chuẩn JCS (RFC 8785):
 * Sắp xếp toàn bộ keys theo thứ tự từ điển UTF-16 đệ quy,
 * chuẩn hóa số âm 0 (-0 -> 0), bảo toàn 100% các thuộc tính con bên trong nested objects và arrays.
 */
export function canonicalJsonStringify(value: unknown): string {
  validateIJsonDomain(value);

  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && Object.is(value, -0)) {
      return '0';
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return (
      '[' +
      value.map((item) => canonicalJsonStringify(item)).join(',') +
      ']'
    );
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries: string[] = [];

  for (const key of sortedKeys) {
    entries.push(
      JSON.stringify(key) + ':' + canonicalJsonStringify(obj[key]),
    );
  }

  return '{' + entries.join(',') + '}';
}

/**
 * Tính toán Full Mutation Canonical Hash bao phủ toàn bộ nội dung bất biến.
 * Payload bắt buộc phải là một đối tượng JSON hợp lệ (không chấp nhận thiếu hoặc rỗng ngầm định).
 */
export function computeCanonicalMutationHash(
  mutation: ClientMutationDto,
): string {
  if (
    !mutation ||
    !mutation.payload ||
    typeof mutation.payload !== 'object' ||
    Array.isArray(mutation.payload) ||
    (Object.getPrototypeOf(mutation.payload) !== Object.prototype &&
      Object.getPrototypeOf(mutation.payload) !== null)
  ) {
    throw new Error(
      `[JCS] Mutation payload must be a valid non-null plain JSON object; received ${
        !mutation || mutation.payload === null
          ? 'null'
          : typeof mutation?.payload
      }`,
    );
  }

  const canonicalObject = {
    baseServerRevision: String(mutation.baseServerRevision),
    clientId: mutation.clientId,
    domain: mutation.domain,
    entityId: mutation.entityId,
    mutationId: mutation.mutationId,
    operation: mutation.operation,
    payload: mutation.payload,
  };

  return createHash('sha256')
    .update(canonicalJsonStringify(canonicalObject))
    .digest('hex');
}
