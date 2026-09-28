import 'dart:async';
import '../../../core/storage/offline_database.dart';
import '../../../core/storage/offline_storage_paths.dart';
import '../models/storage_policy_config.dart';
import '../repositories/artifact_repository.dart';
import '../repositories/offline_storage_repository.dart';
import 'active_checkpoint_provider.dart';
import 'artifact_download_client.dart';
import 'bundle_installer.dart';
import 'disk_space_provider.dart';
import 'download_queue_manager.dart';
import 'offline_content_resolver.dart';
import 'offline_deletion_service.dart';
import 'reader_lease_manager.dart';
import 'storage_admission_coordinator.dart';
import 'storage_quota_manager.dart';

/// Phạm vi Quản lý Ngoại tuyến theo Người dùng (Offline User Scope - SSoT Dependency Composition).
///
/// Đảm bảo tính toàn vẹn kiến trúc (P0.3, P0.7, Gate 6, Gate 7):
/// 1. Tất cả các thành phần offline đều liên kết chặt chẽ với cùng một `userId` duy nhất.
/// 2. Khóa Admission Non-Bypass: Bắt buộc [StorageAdmissionCoordinator] trong cả [DownloadQueueManager]
///    và [BundleInstaller].
/// 3. Shared Concurrency Ledger: [DownloadQueueManager] và [BundleInstaller] BẮT BUỘC sử dụng chung
///    một instance [StorageAdmissionCoordinator] duy nhất per user để 3 ledger RAM (download remaining,
///    extraction remaining, install quota reservation) đồng bộ tuyệt đối, ngăn chặn concurrent overcommit.
class OfflineUserScope {
  final String userId;
  final OfflineStoragePaths storagePaths;
  final OfflineStorageRepository repository;
  final DiskSpaceProvider diskSpaceProvider;
  final StoragePolicyConfig policyConfig;
  final ReaderLeaseManager readerLeaseManager;
  final ActiveCheckpointProvider checkpointProvider;
  final OfflineDeletionService deletionService;
  final StorageQuotaManager quotaManager;
  final StorageAdmissionCoordinator admissionCoordinator;
  final BundleInstaller bundleInstaller;
  final DownloadQueueManager queueManager;
  final OfflineContentResolver contentResolver;

  OfflineUserScope({
    required this.userId,
    required this.storagePaths,
    required this.repository,
    required this.diskSpaceProvider,
    required this.policyConfig,
    required this.readerLeaseManager,
    required this.checkpointProvider,
    required this.deletionService,
    required this.quotaManager,
    required this.admissionCoordinator,
    required this.bundleInstaller,
    required this.queueManager,
    required this.contentResolver,
  }) {
    if (userId.trim().isEmpty) {
      throw ArgumentError('userId không được để trống trong OfflineUserScope');
    }
    if (storagePaths.userId != userId ||
        repository.userId != userId ||
        quotaManager.userId != userId ||
        admissionCoordinator.userId != userId ||
        bundleInstaller.userId != userId ||
        queueManager.userId != userId ||
        contentResolver.userId != userId ||
        deletionService.userId != userId) {
      throw ArgumentError(
        'Identity Mismatch in OfflineUserScope: All components must belong to the exact same userId ($userId)',
      );
    }

    // Invariant Multi-Ledger Sharing:
    if (!identical(bundleInstaller.admissionCoordinator, admissionCoordinator)) {
      throw ArgumentError(
        'Concurrency Ledger Violation: bundleInstaller MUST share the exact same StorageAdmissionCoordinator instance.',
      );
    }
    if (!identical(queueManager.admissionCoordinator, admissionCoordinator)) {
      throw ArgumentError(
        'Concurrency Ledger Violation: queueManager MUST share the exact same StorageAdmissionCoordinator instance.',
      );
    }
  }

  /// Khởi tạo toàn bộ dependency tree cho một user context hợp lệ.
  static Future<OfflineUserScope> create({
    required String userId,
    required OfflineDatabase database,
    required ArtifactRepository artifactRepository,
    required ArtifactDownloadClient downloadClient,
    DiskSpaceProvider? diskSpaceProvider,
    StoragePolicyConfig? policyConfig,
    ReaderLeaseManager? readerLeaseManager,
    ActiveCheckpointProvider? checkpointProvider,
    String? customBasePath,
    ComputeRunner? computeRunner,
  }) async {
    final effectiveDiskSpaceProvider = diskSpaceProvider ?? const DefaultDiskSpaceProvider();
    final effectivePolicyConfig = policyConfig ?? const StoragePolicyConfig();
    final effectiveReaderLeaseManager = readerLeaseManager ?? ReaderLeaseManager();
    final effectiveCheckpointProvider = checkpointProvider ?? InMemoryCheckpointProvider();

    final storagePaths = OfflineStoragePaths(
      userId: userId,
      customBasePath: customBasePath,
    );

    final repository = OfflineStorageRepository(
      database: database,
      userId: userId,
    );

    final deletionService = OfflineDeletionService(
      repository: repository,
      storagePaths: storagePaths,
      readerLeaseManager: effectiveReaderLeaseManager,
    );

    final quotaManager = StorageQuotaManager(
      repository: repository,
      storagePaths: storagePaths,
      deletionService: deletionService,
      readerLeaseManager: effectiveReaderLeaseManager,
      diskSpaceProvider: effectiveDiskSpaceProvider,
      checkpointProvider: effectiveCheckpointProvider,
      config: effectivePolicyConfig,
    );

    // DUY NHẤT 1 instance StorageAdmissionCoordinator per user scope
    final admissionCoordinator = StorageAdmissionCoordinator(
      diskSpaceProvider: effectiveDiskSpaceProvider,
      storageQuotaManager: quotaManager,
      storagePaths: storagePaths,
      config: effectivePolicyConfig,
    );

    final bundleInstaller = BundleInstaller(
      repository: repository,
      storagePaths: storagePaths,
      admissionCoordinator: admissionCoordinator,
      computeRunner: computeRunner,
    );

    final queueManager = DownloadQueueManager(
      repository: repository,
      artifactRepository: artifactRepository,
      downloadClient: downloadClient,
      storagePaths: storagePaths,
      admissionCoordinator: admissionCoordinator,
      bundleInstaller: bundleInstaller,
    );

    final contentResolver = OfflineContentResolver(
      repository: repository,
      storagePaths: storagePaths,
      bundleInstaller: bundleInstaller,
    );

    return OfflineUserScope(
      userId: userId,
      storagePaths: storagePaths,
      repository: repository,
      diskSpaceProvider: effectiveDiskSpaceProvider,
      policyConfig: effectivePolicyConfig,
      readerLeaseManager: effectiveReaderLeaseManager,
      checkpointProvider: effectiveCheckpointProvider,
      deletionService: deletionService,
      quotaManager: quotaManager,
      admissionCoordinator: admissionCoordinator,
      bundleInstaller: bundleInstaller,
      queueManager: queueManager,
      contentResolver: contentResolver,
    );
  }

  /// Khởi tạo thư mục và Crash Recovery cho hàng đợi tải.
  Future<void> initialize() async {
    await storagePaths.ensureDirectoriesExist();
    await queueManager.initialize();
  }

  /// Dọn dẹp tài nguyên khi user logout hoặc chuyển tài khoản.
  void dispose() {
    queueManager.dispose();
  }
}
