import 'package:dio/dio.dart';
import '../../../core/api/api_client.dart';
import '../../../core/errors/error_mapper.dart';

/// DTO phản ánh thông tin Artifact từ Core API (chuẩn hóa với ChapterArtifactDto).
class ChapterArtifactInfo {
  final String status; // 'READY' | 'BUILDING' | 'MISSING' | 'FAILED'
  final bool artifactReady;
  final String artifactType; // 'OFFLINE_BUNDLE' | 'TRANSLATION_SOURCE'
  final String chapterVersionId;
  final String? downloadUrl;
  final int? fileSizeBytes;
  final String? sha256;
  final DateTime? expiresAt;
  final int? retryAfter;

  const ChapterArtifactInfo({
    required this.status,
    required this.artifactReady,
    required this.artifactType,
    required this.chapterVersionId,
    this.downloadUrl,
    this.fileSizeBytes,
    this.sha256,
    this.expiresAt,
    this.retryAfter,
  });

  bool get isReady => artifactReady && downloadUrl != null && downloadUrl!.isNotEmpty;

  factory ChapterArtifactInfo.fromJson(Map<String, dynamic> json) {
    return ChapterArtifactInfo(
      status: json['status'] as String? ?? 'MISSING',
      artifactReady: json['artifactReady'] as bool? ?? false,
      artifactType: json['artifactType'] as String? ?? 'OFFLINE_BUNDLE',
      chapterVersionId: json['chapterVersionId'] as String? ?? '',
      downloadUrl: json['downloadUrl'] as String?,
      fileSizeBytes: (json['fileSizeBytes'] as num?)?.toInt(),
      sha256: json['sha256'] as String?,
      expiresAt: json['expiresAt'] != null
          ? DateTime.tryParse(json['expiresAt'] as String)
          : null,
      retryAfter: (json['retryAfter'] as num?)?.toInt(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'status': status,
      'artifactReady': artifactReady,
      'artifactType': artifactType,
      'chapterVersionId': chapterVersionId,
      'downloadUrl': downloadUrl,
      'fileSizeBytes': fileSizeBytes,
      'sha256': sha256,
      'expiresAt': expiresAt?.toIso8601String(),
      'retryAfter': retryAfter,
    };
  }

  @override
  String toString() {
    return 'ChapterArtifactInfo(status: $status, ready: $artifactReady, url: ${downloadUrl != null ? "[PRESIGNED]" : "null"})';
  }
}

/// Repository giao tiếp với Core API để kiểm tra trạng thái và lấy URL tải gói Artifact.
class ArtifactRepository {
  final ApiClient _apiClient;

  ArtifactRepository({required ApiClient apiClient}) : _apiClient = apiClient;

  /// Lấy thông tin trạng thái và presigned download URL của artifact từ Core API.
  Future<ChapterArtifactInfo> getArtifactInfo({
    required String chapterId,
    required String versionId,
    String type = 'OFFLINE_BUNDLE',
    CancelToken? cancelToken,
  }) async {
    try {
      final response = await _apiClient.get<Map<String, dynamic>>(
        '/api/v1/chapters/$chapterId/versions/$versionId/artifact',
        queryParameters: {'type': type},
        cancelToken: cancelToken,
      );

      final data = response.data;
      if (data == null) {
        throw StateError('Phản hồi rỗng từ máy chủ cho artifact');
      }

      return ChapterArtifactInfo.fromJson(data);
    } on DioException catch (e) {
      throw ErrorMapper.fromDio(e);
    }
  }

  /// Kích hoạt tiến trình đóng gói artifact trên server nếu chưa sẵn sàng.
  Future<ChapterArtifactInfo> triggerPackaging({
    required String chapterId,
    required String versionId,
    String type = 'OFFLINE_BUNDLE',
    CancelToken? cancelToken,
  }) async {
    try {
      final response = await _apiClient.post<Map<String, dynamic>>(
        '/api/v1/chapters/$chapterId/versions/$versionId/package',
        data: {'artifactType': type},
        cancelToken: cancelToken,
      );

      final data = response.data;
      if (data == null) {
        throw StateError('Phản hồi rỗng từ máy chủ cho package request');
      }

      return ChapterArtifactInfo.fromJson(data);
    } on DioException catch (e) {
      throw ErrorMapper.fromDio(e);
    }
  }
}
