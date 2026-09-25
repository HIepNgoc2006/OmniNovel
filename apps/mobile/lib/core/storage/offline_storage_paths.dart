import 'dart:io';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';

/// Quản lý phân vùng lưu trữ ngoại tuyến trong App-Private Sandbox (Internal Storage).
/// Đảm bảo phân quyền bảo mật 0700 và tương thích với Android File-Based Encryption (FBE).
class OfflineStoragePaths {
  static const String offlineDirName = 'offline';
  static const String tmpDirName = 'tmp';
  static const String stagingDirName = 'staging';
  static const String installedDirName = 'installed';

  final String? _customBasePath;
  String? _resolvedBasePath;

  OfflineStoragePaths({String? customBasePath})
      : _customBasePath = customBasePath;

  /// Đường dẫn gốc của phân vùng offline: `<app-files-dir>/offline`
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

  /// Đường dẫn thư mục chứa tệp tải tạm thời `.part`
  Future<String> getTmpDirPath() async {
    final root = await getRootOfflinePath();
    return p.join(root, tmpDirName);
  }

  /// Đường dẫn thư mục giải nén trung gian để xác thực toàn vẹn
  Future<String> getStagingDirPath() async {
    final root = await getRootOfflinePath();
    return p.join(root, stagingDirName);
  }

  /// Đường dẫn thư mục lưu trữ các gói chương truyện đã cài đặt chính thức
  Future<String> getInstalledDirPath() async {
    final root = await getRootOfflinePath();
    return p.join(root, installedDirName);
  }

  /// Đường dẫn tệp `.part` cho một chapter version cụ thể
  Future<String> getPartFilePath(String chapterVersionId) async {
    final tmpDir = await getTmpDirPath();
    return p.join(tmpDir, '$chapterVersionId.part');
  }

  /// Lấy đối tượng File cho tệp `.part`
  Future<File> getPartFile(String chapterVersionId) async {
    final path = await getPartFilePath(chapterVersionId);
    return File(path);
  }

  /// Đường dẫn thư mục staging cho một chapter version cụ thể
  Future<String> getStagingPathForVersion(String chapterVersionId) async {
    final stagingDir = await getStagingDirPath();
    return p.join(stagingDir, chapterVersionId);
  }

  /// Đường dẫn thư mục cài đặt chính thức cho một chapter version cụ thể
  Future<String> getInstalledPathForVersion(String chapterVersionId) async {
    final installedDir = await getInstalledDirPath();
    return p.join(installedDir, chapterVersionId);
  }

  /// Khởi tạo và đảm bảo toàn bộ cây thư mục sandbox tồn tại trên đĩa
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
}
