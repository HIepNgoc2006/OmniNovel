import 'dart:convert';

import '../../identity/installation_identity_provider.dart';
import '../errors/sync_storage_exceptions.dart';
import '../utils/canonical_entity_key.dart';

/// Trích xuất JWT Session ID (`sid` hoặc `sessionId`) từ Access Token nếu có.
/// Dùng để bảo đảm `clientId` độc lập hoàn toàn với JWT session claim (Phase 7C.0 Pillar P4).
String? extractJwtSessionId(String? accessToken) {
  if (accessToken == null || accessToken.trim().isEmpty) return null;
  try {
    final parts = accessToken.split('.');
    if (parts.length != 3) return null;
    final normalized = base64Url.normalize(parts[1]);
    final decoded = jsonDecode(utf8.decode(base64Url.decode(normalized)));
    if (decoded is! Map) return null;
    final sid = decoded['sid'] ?? decoded['sessionId'];
    if (sid is String && sid.trim().isNotEmpty) {
      return sid.trim();
    }
    return null;
  } catch (_) {
    return null;
  }
}

/// Nguồn cung cấp `clientId` bền vững cho Mobile Sync (`P1-M08`, Pillar P4).
///
/// Tái sử dụng trực tiếp SSoT sẵn có là [InstallationIdentityProvider]
/// (`FlutterSecureStorage` + fallback `SharedPreferences` với key `'omninovel_installation_id'`),
/// tuân thủ KISS/YAGNI và KHÔNG thêm cột SQLite dư thừa vào `sync_meta`:
/// - Trả về đúng RFC4122 UUIDv4 bền vững qua app restart, SQLite DB close/reopen,
///   `ActiveScopeCoordinator.onLogout()`, `PreferencesService.clearPreferences()`,
///   và đổi tài khoản (`user-A -> user-B`).
/// - Cưỡng chế fail-closed chuẩn RFC4122 UUIDv4 và tách biệt tuyệt đối khỏi `userId`,
///   `guestProfileId` và JWT `sessionId` (`sid`).
class SyncClientIdentityProvider {
  final InstallationIdentityProvider _installationProvider;

  const SyncClientIdentityProvider({
    required InstallationIdentityProvider installationProvider,
  }) : _installationProvider = installationProvider;

  /// Lấy `clientId` bền vững chuẩn RFC4122 UUIDv4 từ [InstallationIdentityProvider],
  /// đồng thời kiểm chứng fail-closed không trùng với [currentUserId], [currentGuestProfileId],
  /// [jwtSessionId], hoặc `sid` claim trong [accessToken].
  Future<String> getOrCreateClientId({
    String? currentUserId,
    String? currentGuestProfileId,
    String? jwtSessionId,
    String? accessToken,
  }) async {
    final rawId = await _installationProvider.getOrCreateInstallationId();
    if (!isValidUuidV4(rawId)) {
      throw InvalidClientIdentityException(
        rawId,
        'INVALID_CLIENT_IDENTITY: Persisted installationId "$rawId" is not a valid RFC4122 UUIDv4.',
      );
    }

    final normalizedClientId = rawId.toLowerCase();

    if (currentUserId != null &&
        currentUserId.trim().isNotEmpty &&
        normalizedClientId == currentUserId.trim().toLowerCase()) {
      throw InvalidClientIdentityException(
        normalizedClientId,
        'CLIENT_ID_IDENTITY_COLLISION: clientId must be strictly distinct from userId.',
      );
    }

    if (currentGuestProfileId != null &&
        currentGuestProfileId.trim().isNotEmpty &&
        normalizedClientId == currentGuestProfileId.trim().toLowerCase()) {
      throw InvalidClientIdentityException(
        normalizedClientId,
        'CLIENT_ID_IDENTITY_COLLISION: clientId must be strictly distinct from guestProfileId.',
      );
    }

    final effectiveSid =
        (jwtSessionId != null && jwtSessionId.trim().isNotEmpty)
            ? jwtSessionId.trim()
            : extractJwtSessionId(accessToken);
    if (effectiveSid != null &&
        normalizedClientId == effectiveSid.toLowerCase()) {
      throw InvalidClientIdentityException(
        normalizedClientId,
        'CLIENT_ID_IDENTITY_COLLISION: clientId must be strictly distinct from JWT sessionId (sid).',
      );
    }

    return normalizedClientId;
  }

  /// Kiểm chứng fail-closed rằng [candidateClientId] đúng chuẩn RFC4122 UUIDv4,
  /// không va chạm với `userId`/`guestProfileId`/`jwtSessionId`, và **trùng khớp tuyệt đối**
  /// với danh tính thiết bị bền vững từ [InstallationIdentityProvider] (chặn giả mạo hoặc
  /// tự sinh UUID ngẫu nhiên theo từng mutation).
  Future<void> assertMatchesClientIdentity(
    String candidateClientId, {
    String? currentUserId,
    String? currentGuestProfileId,
    String? jwtSessionId,
    String? accessToken,
  }) async {
    if (!isValidUuidV4(candidateClientId)) {
      throw InvalidClientIdentityException(
        candidateClientId,
        'INVALID_CLIENT_IDENTITY: candidate clientId "$candidateClientId" must be a valid RFC4122 UUIDv4.',
      );
    }

    final expectedClientId = await getOrCreateClientId(
      currentUserId: currentUserId,
      currentGuestProfileId: currentGuestProfileId,
      jwtSessionId: jwtSessionId,
      accessToken: accessToken,
    );

    if (candidateClientId.trim().toLowerCase() != expectedClientId) {
      throw InvalidClientIdentityException(
        candidateClientId,
        'CLIENT_ID_SPOOFING_REJECTED: Mutation clientId "$candidateClientId" does not match durable device identity "$expectedClientId".',
      );
    }
  }
}
