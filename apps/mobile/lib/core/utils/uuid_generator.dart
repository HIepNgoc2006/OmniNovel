import 'dart:math';

/// Sinh UUID-v4 chuẩn RFC 4122 dùng Random.secure()
String generateUuidV4() {
  final random = Random.secure();
  final values = List<int>.generate(16, (_) => random.nextInt(256));

  // Version 4: 0100xxxx (nibble 4)
  values[6] = (values[6] & 0x0f) | 0x40;
  // Variant RFC 4122: 10xxxxxx (nibbles 8, 9, a, b)
  values[8] = (values[8] & 0x3f) | 0x80;

  String toHex(int val) => val.toRadixString(16).padLeft(2, '0');

  final sb = StringBuffer();
  for (int i = 0; i < 16; i++) {
    if (i == 4 || i == 6 || i == 8 || i == 10) {
      sb.write('-');
    }
    sb.write(toHex(values[i]));
  }
  return sb.toString();
}
