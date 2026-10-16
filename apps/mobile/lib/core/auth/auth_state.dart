import '../../features/auth/models/auth_models.dart';

enum AuthStatus {
  initial,
  unauthenticated,
  authenticating,
  authenticated,
  pendingVerification,
}

class AuthState {
  final AuthStatus status;
  final User? user;
  final String? accessToken;
  final String? errorMessage;

  const AuthState({
    required this.status,
    this.user,
    this.accessToken,
    this.errorMessage,
  });

  factory AuthState.initial() => const AuthState(status: AuthStatus.initial);

  factory AuthState.unauthenticated([String? message]) => AuthState(
        status: AuthStatus.unauthenticated,
        errorMessage: message,
      );

  factory AuthState.authenticating() => const AuthState(status: AuthStatus.authenticating);

  factory AuthState.authenticated({
    required User user,
    required String accessToken,
  }) =>
      AuthState(
        status: AuthStatus.authenticated,
        user: user,
        accessToken: accessToken,
      );

  factory AuthState.pendingVerification({
    required User hintUser,
    required String accessToken,
    String? message,
  }) =>
      AuthState(
        status: AuthStatus.pendingVerification,
        user: hintUser,
        accessToken: accessToken,
        errorMessage: message,
      );

  bool get isAuthenticated => status == AuthStatus.authenticated;
  bool get isPendingVerification => status == AuthStatus.pendingVerification;
  bool get isVerifiedAuth => status == AuthStatus.authenticated;
  bool get isLoading => status == AuthStatus.authenticating || status == AuthStatus.initial;
}

