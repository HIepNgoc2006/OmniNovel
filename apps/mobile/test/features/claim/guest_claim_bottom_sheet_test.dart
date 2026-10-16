import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/claim/guest_claim_coordinator.dart';
import 'package:omninovel_mobile/core/claim/models/guest_claim_models.dart';
import 'package:omninovel_mobile/features/claim/presentation/guest_claim_bottom_sheet.dart';

class MockGuestClaimCoordinator extends Mock implements GuestClaimCoordinator {}

void main() {
  group('GuestClaimBottomSheet Widget Tests (TDD RED)', () {
    late MockGuestClaimCoordinator mockCoordinator;

    final standardPreview = GuestClaimPreviewResult(
      claimId: 'claim-modal-1',
      status: GuestClaimStatus.prepared,
      stateFingerprint: 'fp-123',
      expiresAt: '2026-10-15T12:00:00.000Z',
      bookmarksToImport: 5,
      historyToImport: 12,
      progressToImport: 3,
      conflictsCount: 1,
      readStatesIgnoredAntiResurrectionCount: 0,
      conflicts: [
        ReadingProgressConflict(
          storyId: 'story-conflict-1',
          cloudProgress: GuestProgressItem(
            storyId: 'story-conflict-1',
            chapterId: 'chap-10',
            pageIndex: 1,
            scrollPosition: 0.0,
            progressPercentage: 80.0,
            readingMode: ReadingMode.webtoon,
          ),
          guestProgress: GuestProgressItem(
            storyId: 'story-conflict-1',
            chapterId: 'chap-15',
            pageIndex: 1,
            scrollPosition: 0.0,
            progressPercentage: 30.0,
            readingMode: ReadingMode.webtoon,
          ),
        ),
      ],

    );

    setUp(() {
      mockCoordinator = MockGuestClaimCoordinator();
      when(() => mockCoordinator.previewData).thenReturn(standardPreview);
      when(() => mockCoordinator.isCommitting).thenReturn(false);
      when(() => mockCoordinator.error).thenReturn(null);
    });

    testWidgets('1. Renders metrics summary (bookmarks, history, progress, conflicts)', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: GuestClaimBottomSheet(
              coordinator: mockCoordinator,
              userId: 'user-modal-1',
            ),
          ),
        ),
      );

      expect(find.textContaining('5'), findsWidgets); // bookmarks
      expect(find.textContaining('12'), findsWidgets); // history
      expect(find.textContaining('3'), findsWidgets); // progress
      expect(find.textContaining('story-conflict-1'), findsOneWidget);
    });

    testWidgets('2. Conflict resolution choice updates decision and calls confirmClaim', (tester) async {
      when(() => mockCoordinator.confirmClaim(any(), any())).thenAnswer((_) async {});

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: GuestClaimBottomSheet(
              coordinator: mockCoordinator,
              userId: 'user-modal-1',
            ),
          ),
        ),
      );

      // Default is keepCloud, select useGuest radio
      final useGuestRadio = find.byKey(const Key('conflict_radio_use_guest_story-conflict-1'));
      if (useGuestRadio.evaluate().isNotEmpty) {
        await tester.tap(useGuestRadio);
        await tester.pump();
      }

      final confirmBtn = find.byKey(const Key('confirm_claim_button'));
      expect(confirmBtn, findsOneWidget);
      await tester.tap(confirmBtn);
      await tester.pump();

      verify(() => mockCoordinator.confirmClaim('user-modal-1', any())).called(1);
    });

    testWidgets('3. Skip button calls coordinator.skipClaim', (tester) async {
      when(() => mockCoordinator.skipClaim(any())).thenAnswer((_) async {});

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: GuestClaimBottomSheet(
              coordinator: mockCoordinator,
              userId: 'user-modal-1',
            ),
          ),
        ),
      );

      final skipBtn = find.byKey(const Key('skip_claim_button'));
      expect(skipBtn, findsOneWidget);
      await tester.tap(skipBtn);
      await tester.pump();

      verify(() => mockCoordinator.skipClaim('user-modal-1')).called(1);
    });

    testWidgets('4. When isCommitting is true, shows progress indicator and disables skip button', (tester) async {
      when(() => mockCoordinator.isCommitting).thenReturn(true);

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: GuestClaimBottomSheet(
              coordinator: mockCoordinator,
              userId: 'user-modal-1',
            ),
          ),
        ),
      );

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      final skipBtn = tester.widget<TextButton>(find.byKey(const Key('skip_claim_button')));
      expect(skipBtn.onPressed, isNull);
    });

    testWidgets('5. Displays error banner and retry button when coordinator has error', (tester) async {
      when(() => mockCoordinator.error).thenReturn('Network timeout during commit');
      when(() => mockCoordinator.confirmClaim(any(), any())).thenAnswer((_) async {});

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: GuestClaimBottomSheet(
              coordinator: mockCoordinator,
              userId: 'user-modal-1',
            ),
          ),
        ),
      );

      expect(find.textContaining('Network timeout during commit'), findsOneWidget);
      final retryBtn = find.byKey(const Key('retry_claim_button'));
      expect(retryBtn, findsOneWidget);
      await tester.tap(retryBtn);
      await tester.pump();

      verify(() => mockCoordinator.confirmClaim('user-modal-1', any())).called(1);
    });
  });
}
