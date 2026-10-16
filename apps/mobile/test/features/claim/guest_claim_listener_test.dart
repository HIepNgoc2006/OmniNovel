import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:provider/provider.dart';
import 'package:omninovel_mobile/core/auth/auth_service.dart';
import 'package:omninovel_mobile/core/auth/auth_state.dart';
import 'package:omninovel_mobile/core/claim/guest_claim_coordinator.dart';
import 'package:omninovel_mobile/core/claim/models/guest_claim_models.dart';
import 'package:omninovel_mobile/features/auth/models/auth_models.dart';
import 'package:omninovel_mobile/features/claim/presentation/guest_claim_listener.dart';
import 'package:omninovel_mobile/features/claim/presentation/guest_claim_bottom_sheet.dart';

class MockGuestClaimCoordinator extends Mock implements GuestClaimCoordinator {}
class MockAuthService extends Mock implements AuthService {}

void main() {
  group('GuestClaimListener Lifecycle Orchestration Tests (TDD RED)', () {
    late MockGuestClaimCoordinator mockCoordinator;
    late MockAuthService mockAuthService;

    final standardPreview = GuestClaimPreviewResult(
      claimId: 'claim-modal-1',
      status: GuestClaimStatus.prepared,
      stateFingerprint: 'fp-123',
      expiresAt: '2026-10-15T12:00:00.000Z',
      bookmarksToImport: 5,
      historyToImport: 12,
      progressToImport: 3,
      conflictsCount: 0,
      readStatesIgnoredAntiResurrectionCount: 0,
      conflicts: const [],
    );

    setUp(() {
      mockCoordinator = MockGuestClaimCoordinator();
      mockAuthService = MockAuthService();

      when(() => mockCoordinator.previewData).thenReturn(standardPreview);
      when(() => mockCoordinator.isCommitting).thenReturn(false);
      when(() => mockCoordinator.error).thenReturn(null);
      when(() => mockCoordinator.isOpen).thenReturn(false);
      when(() => mockCoordinator.checkCrashRecovery(any())).thenAnswer((_) async => CrashRecoveryResult.noPending);
      when(() => mockCoordinator.checkAndPrepareClaim(any())).thenAnswer((_) async {});
      when(() => mockCoordinator.resetSession()).thenReturn(null);

      when(() => mockAuthService.state).thenReturn(AuthState.unauthenticated());
    });

    testWidgets('1. When Auth transitions to verified authenticated -> triggers checkCrashRecovery and checkAndPrepareClaim', (tester) async {
      final user = const User(id: 'u-orch-1', username: 'testuser', email: 'test@example.com', role: 'READER');
      when(() => mockAuthService.state).thenReturn(AuthState.authenticated(user: user, accessToken: 'token'));

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<GuestClaimCoordinator>.value(value: mockCoordinator),
            ChangeNotifierProvider<AuthService>.value(value: mockAuthService),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: GuestClaimListener(
                child: Text('App Shell Child'),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      verify(() => mockCoordinator.checkCrashRecovery('u-orch-1')).called(1);
      verify(() => mockCoordinator.checkAndPrepareClaim('u-orch-1')).called(1);
    });

    testWidgets('2. When Auth is in pendingVerification -> does NOT trigger checkAndPrepareClaim', (tester) async {
      final hintUser = const User(id: 'u-offline-1', username: 'offline', email: 'off@example.com', role: 'READER');
      when(() => mockAuthService.state).thenReturn(AuthState.pendingVerification(hintUser: hintUser, accessToken: 'token'));

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<GuestClaimCoordinator>.value(value: mockCoordinator),
            ChangeNotifierProvider<AuthService>.value(value: mockAuthService),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: GuestClaimListener(
                child: Text('App Shell Child'),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // P0-1 Invariant: No claim preparation triggered when pendingVerification
      verifyNever(() => mockCoordinator.checkAndPrepareClaim(any()));
    });

    testWidgets('3. When coordinator.isOpen turns true -> displays GuestClaimBottomSheet', (tester) async {
      final user = const User(id: 'u-orch-1', username: 'testuser', email: 'test@example.com', role: 'READER');
      when(() => mockAuthService.state).thenReturn(AuthState.authenticated(user: user, accessToken: 'token'));
      when(() => mockCoordinator.isOpen).thenReturn(true);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<GuestClaimCoordinator>.value(value: mockCoordinator),
            ChangeNotifierProvider<AuthService>.value(value: mockAuthService),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: GuestClaimListener(
                child: Text('App Shell Child'),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300)); // bottom sheet animation

      expect(find.byType(GuestClaimBottomSheet), findsOneWidget);
    });

    testWidgets('4. Rebuild-resilience: root widget rebuilds do not open duplicate modal', (tester) async {
      final user = const User(id: 'u-orch-1', username: 'testuser', email: 'test@example.com', role: 'READER');
      when(() => mockAuthService.state).thenReturn(AuthState.authenticated(user: user, accessToken: 'token'));
      when(() => mockCoordinator.isOpen).thenReturn(true);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<GuestClaimCoordinator>.value(value: mockCoordinator),
            ChangeNotifierProvider<AuthService>.value(value: mockAuthService),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: GuestClaimListener(
                child: Text('App Shell Child'),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Trigger multiple rebuilds
      await tester.pump();
      await tester.pump();

      expect(find.byType(GuestClaimBottomSheet), findsOneWidget);
    });

    testWidgets('5. When Auth logs out while modal is showing -> automatically pops modal and calls resetSession', (tester) async {
      final user = const User(id: 'u-orch-1', username: 'testuser', email: 'test@example.com', role: 'READER');
      when(() => mockAuthService.state).thenReturn(AuthState.authenticated(user: user, accessToken: 'token'));
      when(() => mockCoordinator.isOpen).thenReturn(true);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<GuestClaimCoordinator>.value(value: mockCoordinator),
            ChangeNotifierProvider<AuthService>.value(value: mockAuthService),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: GuestClaimListener(
                child: Text('App Shell Child'),
              ),
            ),
          ),
        ),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.byType(GuestClaimBottomSheet), findsOneWidget);

      // Now Auth logs out
      when(() => mockAuthService.state).thenReturn(AuthState.unauthenticated());
      when(() => mockCoordinator.isOpen).thenReturn(false);

      // Re-pump widget to trigger build with updated mock state
      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<GuestClaimCoordinator>.value(value: mockCoordinator),
            ChangeNotifierProvider<AuthService>.value(value: mockAuthService),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: GuestClaimListener(
                child: Text('App Shell Child'),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(GuestClaimBottomSheet), findsNothing);
      verify(() => mockCoordinator.resetSession()).called(1);
    });

    testWidgets('6. When checkCrashRecovery returns pendingUnavailable or userActionRequired -> does NOT trigger checkAndPrepareClaim (P0-2)', (tester) async {
      final user = const User(id: 'u-orch-1', username: 'testuser', email: 'test@example.com', role: 'READER');
      when(() => mockAuthService.state).thenReturn(AuthState.authenticated(user: user, accessToken: 'token'));
      when(() => mockCoordinator.checkCrashRecovery(any())).thenAnswer((_) async => CrashRecoveryResult.pendingUnavailable);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<GuestClaimCoordinator>.value(value: mockCoordinator),
            ChangeNotifierProvider<AuthService>.value(value: mockAuthService),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: GuestClaimListener(
                child: Text('App Shell Child'),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      verify(() => mockCoordinator.checkCrashRecovery('u-orch-1')).called(1);
      // Invariant P0-2: checkAndPrepareClaim MUST NOT be called!
      verifyNever(() => mockCoordinator.checkAndPrepareClaim(any()));
    });
  });
}

