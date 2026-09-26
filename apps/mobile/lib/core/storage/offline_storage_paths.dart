import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// Quản lý phân vùng lưu trữ ngoại tuyến trong App-Private Sandbox (Internal Storage).
/// Đảm bảo phân quyền bảo mật 0700 và tương thích với Android File-Based Encryption (FBE).
/// Phân vùng 3 vùng theo userScope (SHA-256 deterministic hash):
///   files/offline/<userScope>/
///     tmp/        # <chapterVersionId>.part
///     staging/    # <chapterVersionId>/
///     installed/  # <chapterVersionId>/
class OfflineStoragePaths {
  static const String offlineDirName = 'offline';
  static const String tmpDirName = 'tmp';
  static const String stagingDirName = 'staging';
  static const String installedDirName = 'installed';

  final String? _customBasePath;
  final String? _userId;
  String? _resolvedBasePath;

  OfflineStoragePaths({
    String? customBasePath,
    String? userId,
  })  : _customBasePath = customBasePath,
        _userId = userId;

  /// Tạo instance mới bind với userId cụ thể.
  OfflineStoragePaths forUser(String newUserId) {
    return OfflineStoragePaths(
      customBasePath: _customBasePath,
      userId: newUserId,
    );
  }

  /// Hàm canonical, stable và path-safe để chuyển đổi userId thành userScope.
  /// Sử dụng 16 ký tự hex đầu tiên của SHA-256 để:
  /// - Không chứa path separator ('/' hoặc '\')
  /// - Không chứa ký tự lạ filesystem ('..', ':', spaces)
  /// - Hoàn toàn deterministic (cùng userId cho ra cùng userScope).
  static String stableSafeScope(String userId) {
    final bytes = utf8.encode(userId);
    final digest = sha256.convert(bytes);
    return digest.toString().substring(0, 16);
  }

  /// userScope của instance hiện tại. Nếu userId null -> fallback 'default'.
  String get userScope => _userId != null ? stableSafeScope(_userId) : 'default';

  /// Đường dẫn gốc của toàn bộ phân vùng offline: `<app-files-dir>/offline`
  Future<String> getRootOfflinePath() async {
    if (_resolvedBasePath != null) {
      return _resolvedBasePath!;
    }
    final custom = _customBasePath;
    if (custom != null) {
      _resolvedBasePath = custom;
      return custom;
    }

    final appDocDir = await getApplicationDocumentsDirectory();
    _resolvedBasePath = p.join(appDocDir.path, offlineDirName);
    return _resolvedBasePath!;
  }

  /// Đường dẫn phân vùng riêng của user: `<root>/<userScope>`
  Future<String> getUserOfflinePath() async {
    final root = await getRootOfflinePath();
    return p.join(root, userScope);
  }

  /// Đường dẫn thư mục chứa tệp tải tạm thời `.part` của user: `<root>/<userScope>/tmp`
  Future<String> getTmpDirPath() async {
    final userRoot = await getUserOfflinePath();
    return p.join(userRoot, tmpDirName);
  }

  /// Đường dẫn thư mục giải nén trung gian để xác thực toàn vẹn của user: `<root>/<userScope>/staging`
  Future<String> getStagingDirPath() async {
    final userRoot = await getUserOfflinePath();
    return p.join(userRoot, stagingDirName);
  }

  /// Đường dẫn thư mục lưu trữ các gói chương truyện đã cài đặt chính thức của user: `<root>/<userScope>/installed`
  Future<String> getInstalledDirPath() async {
    final userRoot = await getUserOfflinePath();
    return p.join(userRoot, installedDirName);
  }

  /// Đường dẫn tệp `.part` cho một chapter version cụ thể của user
  Future<String> getPartFilePath(String chapterVersionId) async {
    final tmpDir = await getTmpDirPath();
    return p.join(tmpDir, '$chapterVersionId.part');
  }

  /// Lấy đối tượng File cho tệp `.part`
  Future<File> getPartFile(String chapterVersionId) async {
    final path = await getPartFilePath(chapterVersionId);
    return File(path);
  }

  /// Đường dẫn thư mục staging cho một chapter version cụ thể của user
  Future<String> getStagingPathForVersion(String chapterVersionId) async {
    final stagingDir = await getStagingDirPath();
    return p.join(stagingDir, chapterVersionId);
  }

  /// Đường dẫn thư mục cài đặt chính thức cho một chapter version cụ thể của user
  Future<String> getInstalledPathForVersion(String chapterVersionId) async {
    final installedDir = await getInstalledDirPath();
    return p.join(installedDir, chapterVersionId);
  }

  /// Khởi tạo và đảm bảo toàn bộ cây thư mục sandbox 3 vùng của user tồn tại trên đĩa
  Future<void> ensureDirectoriesExist() async {
    final tmp = Directory(await getTmpDirPath());
    final staging = Directory(await getStagingDirPath());
    final installed = Directory(await getInstalledDirPath());

    if (!await tmp.exists()) {
      await tmp.create(recursive: true);
    }
    if (!await staging.exists()) {
      await staging.create(recursive: true);
    }
    if (!await installed.exists()) {
      await installed.create(recursive: true);
    }
  }

  /// Dọn dẹp tệp `.part` nếu tồn tại (idempotent, an toàn khi concurrent cleanup)
  Future<void> deletePartFile(String chapterVersionId) async {
    final file = await getPartFile(chapterVersionId);
    try {
      if (await file.exists()) {
        await file.delete();
      }
    } on FileSystemException {
      // Đã được xóa bởi tiến trình khác hoặc không còn tồn tại
    }
  }

  /// Dọn dẹp thư mục staging nếu tồn tại (idempotent)
  Future<void> deleteStagingDir(String chapterVersionId) async {
    final path = await getStagingPathForVersion(chapterVersionId);
    final dir = Directory(path);
    try {
      if (await dir.exists()) {
        await dir.delete(recursive: true);
      }
    } on FileSystemException {
      // Đã được xóa bởi tiến trình khác hoặc không còn tồn tại
    }
  }

  /// Dọn dẹp thư mục installed nếu tồn tại (idempotent)
  Future<void> deleteInstalledDir(String chapterVersionId) async {
    final path = await getInstalledPathForVersion(chapterVersionId);
    final dir = Directory(path);
    try {
      if (await dir.exists()) {
        await dir.delete(recursive: true);
      }
    } on FileSystemException {
      // Đã được xóa bởi tiến trình khác hoặc không còn tồn tại
    }
  }
}
