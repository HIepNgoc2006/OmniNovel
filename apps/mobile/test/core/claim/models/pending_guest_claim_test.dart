import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/claim/models/guest_claim_models.dart';
import 'package:omninovel_mobile/core/claim/models/pending_guest_claim.dart';

void main() {
  group('Task 1: PendingGuestClaim & Recovery Models Test Suite', () {
    const validFingerprint =
        'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    final now = DateTime.utc(2026, 10, 14, 9, 30, 0);

    test('ClaimRecoveryPhase has strictly 3 observable phases and no rebindCompleted', () {
      expect(ClaimRecoveryPhase.values.length, 3);
      expect(ClaimRecoveryPhase.values, contains(ClaimRecoveryPhase.prepared));
      expect(ClaimRecoveryPhase.values, contains(ClaimRecoveryPhase.committing));
      expect(ClaimRecoveryPhase.values, contains(ClaimRecoveryPhase.committedServer));
      expect(ClaimRecoveryPhase.values.map((p) => p.name), isNot(contains('rebindCompleted')));
    });

    test('PendingGuestClaim maps to and from SQLite map correctly', () {
      final claim = PendingGuestClaim(
        claimId: 'claim-uuid-1234',
        userId: 'user-uuid-5678',
        guestProfileId: 'guest-profile-9999',
        expectedStateFingerprint: validFingerprint,
        conflictDecisions: const {
          'story-1': ConflictResolution.keepCloud,
          'story-2': ConflictResolution.useGuest,
        },
        phase: ClaimRecoveryPhase.prepared,
        previewDataJson: jsonEncode({'bookmarksToImport': 3, 'historyToImport': 5}),
        createdAt: now,
        updatedAt: now,
      );

      final map = claim.toMap();
      expect(map['claim_id'], 'claim-uuid-1234');
      expect(map['user_id'], 'user-uuid-5678');
      expect(map['guest_profile_id'], 'guest-profile-9999');
      expect(map['expected_state_fingerprint'], validFingerprint);
      expect(map['phase'], 'prepared');
      expect(map['created_at'], now.millisecondsSinceEpoch);
      expect(map['updated_at'], now.millisecondsSinceEpoch);

      // Verify conflictDecisions is serialized as a valid JSON string map
      final decodedDecisions = jsonDecode(map['conflict_decisions'] as String) as Map<String, dynamic>;
      expect(decodedDecisions['story-1'], 'KEEP_CLOUD');
      expect(decodedDecisions['story-2'], 'USE_GUEST');

      // Round-trip fromMap
      final restored = PendingGuestClaim.fromMap(map);
      expect(restored.claimId, claim.claimId);
      expect(restored.userId, claim.userId);
      expect(restored.guestProfileId, claim.guestProfileId);
      expect(restored.expectedStateFingerprint, claim.expectedStateFingerprint);
      expect(restored.phase, ClaimRecoveryPhase.prepared);
      expect(restored.conflictDecisions['story-1'], ConflictResolution.keepCloud);
      expect(restored.conflictDecisions['story-2'], ConflictResolution.useGuest);
      expect(restored.previewDataJson, claim.previewDataJson);
      expect(restored.createdAt.millisecondsSinceEpoch, now.millisecondsSinceEpoch);
      expect(restored.updatedAt.millisecondsSinceEpoch, now.millisecondsSinceEpoch);
    });

    test('PendingGuestClaim.copyWith updates phase, decisions, preview, and updatedAt', () {
      final original = PendingGuestClaim(
        claimId: 'claim-uuid-1234',
        userId: 'user-uuid-5678',
        guestProfileId: 'guest-profile-9999',
        expectedStateFingerprint: validFingerprint,
        phase: ClaimRecoveryPhase.prepared,
        createdAt: now,
        updatedAt: now,
      );

      final later = now.add(const Duration(minutes: 5));
      final updated = original.copyWith(
        phase: ClaimRecoveryPhase.committing,
        conflictDecisions: {'story-99': ConflictResolution.useGuest},
        previewDataJson: '{"new": true}',
        updatedAt: later,
      );

      expect(updated.claimId, original.claimId);
      expect(updated.userId, original.userId);
      expect(updated.phase, ClaimRecoveryPhase.committing);
      expect(updated.conflictDecisions['story-99'], ConflictResolution.useGuest);
      expect(updated.previewDataJson, '{"new": true}');
      expect(updated.updatedAt, later);
      expect(updated.createdAt, now);
    });

    group('Contract Hardening Invariants', () {
      test('CommitGuestClaimPayload enforces 64-char hex SHA-256 fingerprint validation', () {
        // Valid 64-char hex
        expect(
          () => CommitGuestClaimPayload.validated(
            expectedStateFingerprint: validFingerprint,
            conflictDecisions: const {},
          ),
          returnsNormally,
        );

        // Empty string
        expect(
          () => CommitGuestClaimPayload.validated(
            expectedStateFingerprint: '',
            conflictDecisions: const {},
          ),
          throwsArgumentError,
        );

        // Less than 64 characters
        expect(
          () => CommitGuestClaimPayload.validated(
            expectedStateFingerprint: 'a1b2c3',
            conflictDecisions: const {},
          ),
          throwsArgumentError,
        );

        // 64 characters with invalid non-hex characters
        expect(
          () => CommitGuestClaimPayload.validated(
            expectedStateFingerprint: 'z' * 64,
            conflictDecisions: const {},
          ),
          throwsArgumentError,
        );
      });

      test('GuestClaimStatus.fromStrictString throws ArgumentError on unknown status (fail-closed)', () {
        expect(GuestClaimStatus.fromStrictString('PREPARED'), GuestClaimStatus.prepared);
        expect(GuestClaimStatus.fromStrictString('COMMITTED'), GuestClaimStatus.committed);
        expect(GuestClaimStatus.fromStrictString('ABORTED'), GuestClaimStatus.aborted);
        expect(GuestClaimStatus.fromStrictString('EXPIRED'), GuestClaimStatus.expired);

        // Case-insensitive trimming
        expect(GuestClaimStatus.fromStrictString('  prepared  '), GuestClaimStatus.prepared);

        // Fail-closed on invalid status
        expect(() => GuestClaimStatus.fromStrictString(null), throwsArgumentError);
        expect(() => GuestClaimStatus.fromStrictString(''), throwsArgumentError);
        expect(() => GuestClaimStatus.fromStrictString('UNKNOWN_STATUS'), throwsArgumentError);
      });

      test('GuestProgressItem enforces 1-based pageIndex (pageIndex >= 1)', () {
        final itemZero = GuestProgressItem(
          storyId: 's1',
          chapterId: 'c1',
          readingMode: ReadingMode.paged,
          pageIndex: 0,
          scrollPosition: 0.0,
          progressPercentage: 50.0,
        );
        expect(itemZero.safePageIndex, 1);

        final itemNegative = GuestProgressItem(
          storyId: 's1',
          chapterId: 'c1',
          readingMode: ReadingMode.paged,
          pageIndex: -5,
          scrollPosition: 0.0,
          progressPercentage: 50.0,
        );
        expect(itemNegative.safePageIndex, 1);

        final itemValid = GuestProgressItem(
          storyId: 's1',
          chapterId: 'c1',
          readingMode: ReadingMode.paged,
          pageIndex: 42,
          scrollPosition: 0.0,
          progressPercentage: 50.0,
        );
        expect(itemValid.safePageIndex, 42);
      });
    });
  });
}
