// Helpers chuẩn hóa & so sánh server revision dạng chuỗi thập phân PostgreSQL 64-bit BIGINT.
//
// Server sử dụng kiểu BIGINT nên chuỗi số có thể vượt quá giới hạn JS Number.MAX_SAFE_INTEGER (2^53 - 1).
// Toàn bộ validation và so sánh ở Mobile luôn parse sang [BigInt] và kiểm tra cận trên [kMaxSignedBigInt64].

/// Giá trị lớn nhất của signed 64-bit BIGINT trong PostgreSQL (`2^63 - 1`).
final BigInt kMaxSignedBigInt64 = BigInt.parse('9223372036854775807');

/// Regex chuỗi số thập phân chuẩn (canonical): `'0'` hoặc số nguyên dương không có số 0 dẫn đầu.
final RegExp _canonicalDecimalRevisionRegex = RegExp(r'^(0|[1-9][0-9]*)$');

/// Kiểm tra [value] có phải chuỗi revision thập phân chuẩn hợp lệ trong dải `[0, 2^63 - 1]`.
bool isValidRevisionString(Object? value) {
  if (value is! String || !_canonicalDecimalRevisionRegex.hasMatch(value)) {
    return false;
  }
  final parsed = BigInt.tryParse(value);
  if (parsed == null) {
    return false;
  }
  return parsed >= BigInt.zero && parsed <= kMaxSignedBigInt64;
}

/// Parse [value] thành [BigInt] sau khi kiểm định chặt chuẩn canonical decimal BIGINT.
BigInt parseRevisionBigInt(String value) {
  if (!isValidRevisionString(value)) {
    throw FormatException(
      'Invalid canonical 64-bit BIGINT decimal revision string: "$value".',
    );
  }
  return BigInt.parse(value);
}

/// So sánh thứ tự nhân quả giữa hai revision strings hợp lệ (`< 0`, `0`, `> 0`).
int compareRevisions(String a, String b) {
  return parseRevisionBigInt(a).compareTo(parseRevisionBigInt(b));
}
