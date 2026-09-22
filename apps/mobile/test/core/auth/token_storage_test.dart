import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/auth/token_storage.dart';

class MockFlutterSecureStorage extends Mock implements FlutterSecureStorage {}

void main() {
  group('SecureTokenStorage Tests (Encrypted Storage Guarantee)', () {
    late MockFlutterSecureStorage mockStorage;
    late SecureTokenStorage tokenStorage;

    setUp(() {
      mockStorage = MockFlutterSecureStorage();
      tokenStorage = SecureTokenStorage(storage: mockStorage);
    });

    test('saveTokens writes accessToken and refreshToken securely', () async {
      when(() => mockStorage.write(
            key: 'omninovel_access_token',
            value: 'mock_access_123',
          )).thenAnswer((_) async {});
      when(() => mockStorage.write(
            key: 'omninovel_refresh_token',
            value: 'mock_refresh_456',
          )).thenAnswer((_) async {});

      await tokenStorage.saveTokens(
        accessToken: 'mock_access_123',
        refreshToken: 'mock_refresh_456',
      );

      verify(() => mockStorage.write(
            key: 'omninovel_access_token',
            value: 'mock_access_123',
          )).called(1);
      verify(() => mockStorage.write(
            key: 'omninovel_refresh_token',
            value: 'mock_refresh_456',
          )).called(1);
    });

    test('getAccessToken retrieves token from secure storage', () async {
      when(() => mockStorage.read(key: 'omninovel_access_token'))
          .thenAnswer((_) async => 'stored_access_jwt');

      final token = await tokenStorage.getAccessToken();

      expect(token, equals('stored_access_jwt'));
      verify(() => mockStorage.read(key: 'omninovel_access_token')).called(1);
    });

    test('clearTokens deletes both access and refresh tokens', () async {
      when(() => mockStorage.delete(key: 'omninovel_access_token'))
          .thenAnswer((_) async {});
      when(() => mockStorage.delete(key: 'omninovel_refresh_token'))
          .thenAnswer((_) async {});

      await tokenStorage.clearTokens();

      verify(() => mockStorage.delete(key: 'omninovel_access_token')).called(1);
      verify(() => mockStorage.delete(key: 'omninovel_refresh_token')).called(1);
    });
  });
}
