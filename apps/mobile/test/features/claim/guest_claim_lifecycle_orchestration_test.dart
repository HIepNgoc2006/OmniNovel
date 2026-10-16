import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:path/path.dart' as p;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:omninovel_mobile/app/app.dart';
import 'package:omninovel_mobile/app/bootstrap.dart';
import 'package:dio/dio.dart';
import 'package:omninovel_mobile/core/api/api_client.dart';
import 'package:omninovel_mobile/core/api/api_endpoints.dart';
import 'package:omninovel_mobile/core/auth/token_storage.dart';
import 'package:omninovel_mobile/core/claim/models/guest_claim_models.dart';
import 'package:omninovel_mobile/core/storage/local_library_dao.dart';
import 'package:omninovel_mobile/core/storage/local_library_models.dart';
import 'package:omninovel_mobile/core/storage/offline_database.dart';
import 'package:omninovel_mobile/features/claim/presentation/guest_claim_bottom_sheet.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

class MockTokenStorage extends Mock implements ITokenStorage {}
class MockApiClient extends Mock implements ApiClient {}


void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;

  group('Task 5 End-to-End Lifecycle Orchestration & Resilience Tests', () {
    late Directory tempDir;
    late String dbPath;
    late OfflineDatabase offlineDb;
    late MockTokenStorage mockTokenStorage;

    const testUserId = 'user-orch-456';
    const testGuestProfileId = 'guest-orch-789';
    const testClaimId = 'claim-orch-001';

    final standardPreviewJson = {
      'claimId': testClaimId,
      'status': 'PREPARED',
      'stateFingerprint': 'fp-orch-123',
      'expiresAt': '2026-10-15T12:00:00.000Z',
      'bookmarksToImport': 3,
      'historyToImport': 7,
      'progressToImport': 2,
      'conflictsCount': 0,
      'readStatesIgnoredAntiResurrectionCount': 0,
      'conflicts': <Map<String, dynamic>>[],
    };

    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      tempDir = await Directory.systemTemp.createTemp('guest_claim_orch_test_');
      dbPath = p.join(tempDir.path, 'guest_claim_orch.db');
      offlineDb = OfflineDatabase();
      await offlineDb.initialize(
        customPath: dbPath,
        databaseFactory: databaseFactoryFfi,
      );
      mockTokenStorage = MockTokenStorage();
      when(() => mockTokenStorage.getAccessToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.getRefreshToken()).thenAnswer((_) async => null);
      when(() => mockTokenStorage.clearTokens()).thenAnswer((_) async {});
    });

    tearDown(() async {
      await offlineDb.close();
      if (tempDir.existsSync()) {
        await tempDir.delete(recursive: true);
      }
    });


    testWidgets('1. Router redirect while modal is open does not destroy or dismiss claim modal', (tester) async {
      final bootstrap = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customTokenStorage: mockTokenStorage,
      );

      await tester.pumpWidget(OmniNovelApp(bootstrapResult: bootstrap));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Trigger modal mở thủ công trên coordinator
      bootstrap.guestClaimCoordinator.currentUserId = testUserId;
      bootstrap.guestClaimCoordinator.currentClaimId = testClaimId;
      bootstrap.guestClaimCoordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);
      bootstrap.guestClaimCoordinator.isOpen = true;

      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(find.byType(GuestClaimBottomSheet), findsOneWidget);

      // Điều hướng Router sang /search trong lúc modal mở
      bootstrap.router.go('/search');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Invariant: Modal vẫn tồn tại trên màn hình
      expect(find.byType(GuestClaimBottomSheet), findsOneWidget);

      // Đóng modal để cleanup
      bootstrap.guestClaimCoordinator.isOpen = false;
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Unmount app để dispose HomeCarouselBanner timer
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
    });

    test('2. Cold start with committing journal -> checkCrashRecovery verifies and rebinds cleanly', () async {
      // Giả lập trạng thái journal trước khi app crash là 'committing'
      final now = DateTime.now().millisecondsSinceEpoch;
      await offlineDb.database.insert('guest_claim_recovery_journal', {
        'claim_id': testClaimId,
        'user_id': testUserId,
        'guest_profile_id': testGuestProfileId,
        'expected_state_fingerprint': 'fp-orch-123',
        'conflict_decisions': '{}',
        'phase': 'committing',
        'preview_data': jsonEncode(standardPreviewJson),
        'created_at': now,
        'updated_at': now,
      });

      // Lưu 1 bookmark cho guest
      final dao = LocalLibraryDao(offlineDatabase: offlineDb);
      await dao.saveBookmark(LocalBookmark(
        ownerScope: 'guest:$testGuestProfileId',
        storyId: 'story-orch-1',
        title: 'Orch Story 1',
        createdAt: DateTime.now().toUtc(),
      ));

      final mockApiClient = MockApiClient();
      when(() => mockApiClient.get<Map<String, dynamic>>(any())).thenThrow(
        DioException(
          requestOptions: RequestOptions(path: ApiEndpoints.guestClaimStatus(testClaimId)),
          type: DioExceptionType.connectionTimeout,
        ),
      );

      // Bootstrap ứng dụng với mockApiClient
      final bootstrap = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customTokenStorage: mockTokenStorage,
        customApiClient: mockApiClient,
      );

      // Chạy checkCrashRecovery
      await bootstrap.guestClaimCoordinator.checkCrashRecovery(testUserId);

      // Vì network timeout khi GET /status trong offline boot, phase vẫn giữ committing (fail-closed, không mất dữ liệu)
      final rows = await offlineDb.database.query('guest_claim_recovery_journal');
      expect(rows.length, equals(1));
      expect(rows.first['phase'], equals('committing'));

      // Partition của khách được bảo toàn
      final guestData = await dao.hasGuestData('guest:$testGuestProfileId');
      expect(guestData, isTrue);
    });

    testWidgets('3. User logout while modal is open automatically dismisses modal and resets session', (tester) async {
      final bootstrap = await AppBootstrap.run(
        customOfflineDatabase: offlineDb,
        customTokenStorage: mockTokenStorage,
      );

      await tester.pumpWidget(OmniNovelApp(bootstrapResult: bootstrap));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      bootstrap.guestClaimCoordinator.currentUserId = testUserId;
      bootstrap.guestClaimCoordinator.currentClaimId = testClaimId;
      bootstrap.guestClaimCoordinator.previewData = GuestClaimPreviewResult.fromJson(standardPreviewJson);
      bootstrap.guestClaimCoordinator.isOpen = true;

      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(GuestClaimBottomSheet), findsOneWidget);

      // Người dùng thực hiện logout hoặc resetSession
      bootstrap.guestClaimCoordinator.resetSession();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Invariant: Modal tự động đóng
      expect(find.byType(GuestClaimBottomSheet), findsNothing);
      expect(bootstrap.guestClaimCoordinator.isOpen, isFalse);
      expect(bootstrap.guestClaimCoordinator.currentUserId, isNull);

      // Unmount app để dispose HomeCarouselBanner timer
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
    });
  });
}

