import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import '../api/api_client.dart';
import '../api/api_endpoints.dart';
import '../errors/api_error.dart';
import '../logging/app_logger.dart';
import '../../features/auth/models/auth_models.dart';
import 'auth_state.dart';
import 'token_storage.dart';

class AuthService extends ChangeNotifier {
  final ApiClient _apiClient;
  final ITokenStorage _tokenStorage;
  final AppLogger _logger;

  AuthState _state = AuthState.initial();
  AuthState get state => _state;

  AuthService({
    required ApiClient apiClient,
    required ITokenStorage tokenStorage,
    AppLogger logger = const AppLogger('AuthService'),
  })  : _apiClient = apiClient,
        _tokenStorage = tokenStorage,
        _logger = logger;

  /// Bootstrap kiểm tra token đã lưu khi mở app
  Future<void> initializeAuth() async {
    _logger.i('Khởi tạo Auth: Kiểm tra Access Token và Refresh Token trong Secure Storage...');
    try {
      final accessToken = await _tokenStorage.getAccessToken();
      final refreshToken = await _tokenStorage.getRefreshToken();

      if (accessToken == null || refreshToken == null) {
        _logger.i('Không tìm thấy token đã lưu. Trạng thái: Unauthenticated.');
        _updateState(AuthState.unauthenticated());
        return;
      }

      // Thử gọi /auth/me để xác thực access token
      try {
        final response = await _apiClient.get<Map<String, dynamic>>(ApiEndpoints.me);
        final userData = response.data;
        if (userData != null) {
          final user = User.fromJson(userData);
          _logger.i('Token hợp lệ. Đăng nhập người dùng: ${user.username}');
          _updateState(AuthState.authenticated(user: user, accessToken: accessToken));
          return;
        }
      } on DioException catch (e) {
        if (e.response?.statusCode == 401 || e.response?.statusCode == 403) {
          _logger.w('Token không hợp lệ hoặc đã hết hạn (401/403). Clear tokens và unauthenticated.');
          await _tokenStorage.clearTokens();
          _updateState(AuthState.unauthenticated('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'));
          return;
        }
        // Lỗi mạng tạm thời (AC-09 Network Resilience):
        // Giữ nguyên phiên xác thực, KHÔNG xóa token và KHÔNG downgrade unauthenticated
        _logger.w('Lỗi mạng khi gọi /auth/me ($e). Duy trì phiên xác thực offline.');
        final offlineUser = _decodeUserFromJwt(accessToken);
        if (offlineUser != null) {
          _updateState(AuthState.authenticated(user: offlineUser, accessToken: accessToken));
          return;
        }
        return;
      } catch (e) {
        _logger.w('Lỗi ngoại lệ khi gọi /auth/me: $e');
        final offlineUser = _decodeUserFromJwt(accessToken);
        if (offlineUser != null) {
          _updateState(AuthState.authenticated(user: offlineUser, accessToken: accessToken));
          return;
        }
        return;
      }

      _updateState(AuthState.unauthenticated());
    } catch (e) {
      _logger.e('Lỗi khi khởi tạo auth:', e);
      _updateState(AuthState.unauthenticated());
    }
  }

  /// Đăng nhập bằng identifier (username hoặc email) và password
  Future<void> login({
    required String identifier,
    required String password,
  }) async {
    _updateState(AuthState.authenticating());

    try {
      final response = await _apiClient.post<Map<String, dynamic>>(
        ApiEndpoints.login,
        data: {
          'identifier': identifier,
          'password': password,
        },
      );

      final data = response.data;
      if (data == null) {
        throw const ApiError(
          code: 'INVALID_RESPONSE',
          message: 'Phản hồi từ máy chủ không hợp lệ.',
        );
      }

      final loginRes = LoginResponse.fromJson(data);
      final accessToken = loginRes.accessToken;
      final refreshToken = loginRes.refreshToken;

      if (refreshToken != null && refreshToken.isNotEmpty) {
        await _tokenStorage.saveTokens(
          accessToken: accessToken,
          refreshToken: refreshToken,
        );
      } else {
        await _tokenStorage.saveAccessToken(accessToken);
      }

      _logger.i('Đăng nhập thành công cho user: ${loginRes.user.username}');
      _updateState(AuthState.authenticated(
        user: loginRes.user,
        accessToken: accessToken,
      ));
    } on ApiError catch (e) {
      _logger.w('Đăng nhập thất bại: ${e.message}');
      _updateState(AuthState.unauthenticated(e.message));
      rethrow;
    } catch (e) {
      _logger.e('Đăng nhập lỗi ngoại lệ: $e');
      _updateState(AuthState.unauthenticated('Đã có lỗi xảy ra khi đăng nhập.'));
      rethrow;
    }
  }

  /// Đăng ký tài khoản mới bằng username, email và password
  Future<void> register({
    required String username,
    required String email,
    required String password,
  }) async {
    _updateState(AuthState.authenticating());

    try {
      final response = await _apiClient.post<Map<String, dynamic>>(
        ApiEndpoints.register,
        data: {
          'username': username,
          'email': email,
          'password': password,
        },
      );

      final data = response.data;
      if (data == null) {
        throw const ApiError(
          code: 'INVALID_RESPONSE',
          message: 'Phản hồi từ máy chủ không hợp lệ.',
        );
      }

      final registerRes = LoginResponse.fromJson(data);
      final accessToken = registerRes.accessToken;
      final refreshToken = registerRes.refreshToken;

      if (refreshToken != null && refreshToken.isNotEmpty) {
        await _tokenStorage.saveTokens(
          accessToken: accessToken,
          refreshToken: refreshToken,
        );
      } else {
        await _tokenStorage.saveAccessToken(accessToken);
      }

      _logger.i('Đăng ký thành công cho user: ${registerRes.user.username}');
      _updateState(AuthState.authenticated(
        user: registerRes.user,
        accessToken: accessToken,
      ));
    } on ApiError catch (e) {
      _logger.w('Đăng ký thất bại: ${e.message}');
      _updateState(AuthState.unauthenticated(e.message));
      rethrow;
    } catch (e) {
      _logger.e('Đăng ký lỗi ngoại lệ: $e');
      _updateState(AuthState.unauthenticated('Đã có lỗi xảy ra khi đăng ký.'));
      rethrow;
    }
  }

  /// Đăng xuất và thu hồi session
  Future<void> logout() async {
    _logger.i('Thực hiện đăng xuất...');
    try {
      final refreshToken = await _tokenStorage.getRefreshToken();
      if (refreshToken != null && refreshToken.isNotEmpty) {
        await _apiClient.post<void>(
          ApiEndpoints.logout,
          data: {'refreshToken': refreshToken},
        );
      }
    } catch (e) {
      _logger.w('Gọi logout API gặp lỗi (bỏ qua và tiếp tục xóa local tokens): $e');
    } finally {
      await _tokenStorage.clearTokens();
      _updateState(AuthState.unauthenticated());
    }
  }

  /// Gọi khi AuthInterceptor phát hiện refresh token hết hạn hoặc invalid (401 deterministic logout)
  void handleSessionExpired() {
    _logger.w('Session đã hết hạn. Đăng xuất và đưa về màn hình Login.');
    _tokenStorage.clearTokens();
    _updateState(AuthState.unauthenticated('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.'));
  }

  void _updateState(AuthState newState) {
    _state = newState;
    notifyListeners();
  }

  /// Giải mã thông tin user từ Access Token JWT payload khi mạng không khả dụng (AC-09)
  User? _decodeUserFromJwt(String token) {
    try {
      final parts = token.split('.');
      if (parts.length != 3) return null;
      final normalized = base64Url.normalize(parts[1]);
      final payloadString = utf8.decode(base64Url.decode(normalized));
      final map = jsonDecode(payloadString) as Map<String, dynamic>;
      final userId = (map['sub'] ?? map['id']) as String?;
      if (userId == null || userId.isEmpty) return null;
      return User(
        id: userId,
        username: (map['username'] as String?) ?? 'user',
        email: (map['email'] as String?) ?? '',
        role: (map['role'] as String?) ?? 'READER',
      );
    } catch (_) {
      return null;
    }
  }
}
