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

      test('GuestClaimCommitResult and GuestClaimStatusResult parse finalization snapshot correctly', () {
        final jsonWithFinalization = {
          'claimId': 'claim-1111',
          'status': 'COMMITTED',
          'committedAt': '2026-10-14T10:00:00.000Z',
          'summary': {
            'bookmarksImported': 1,
            'historyMerged': 2,
            'progressUpdated': 1,
            'conflictsResolved': 0,
          },
          'finalization': {
            'tombstonedStoryIds': ['story-dead-1'],
            'finalizedProgress': [
              {
                'storyId': 'story-live-1',
                'chapterId': 'chap-1',
                'chapterVersionId': 'ver-1',
                'readingMode': 'PAGED',
                'pageIndex': 15,
                'scrollPosition': 0.0,
                'progressPercentage': 65.0,
                'anchorBlockId': null,
                'textOffset': null,
                'updatedAt': '2026-10-14T10:00:00.000Z',
              },
            ],
            'finalizedChapterReadStates': [
              {
                'storyId': 'story-live-1',
                'chapterId': 'chap-1',
                'chapterVersionId': 'ver-1',
                'progressPercentage': 100.0,
                'completedAt': '2026-10-14T10:00:00.000Z',
                'lastReadAt': '2026-10-14T10:00:00.000Z',
              },
            ],
          },
        };

        // 1. Commit result parsing
        final commitResult = GuestClaimCommitResult.fromJson(jsonWithFinalization);
        expect(commitResult.status, GuestClaimStatus.committed);
        expect(commitResult.finalization, isNotNull);
        expect(commitResult.finalization!.tombstonedStoryIds, contains('story-dead-1'));
        expect(commitResult.finalization!.finalizedProgress.length, 1);
        expect(commitResult.finalization!.finalizedProgress.first.storyId, 'story-live-1');
        expect(commitResult.finalization!.finalizedProgress.first.pageIndex, 15);
        expect(commitResult.finalization!.finalizedChapterReadStates.length, 1);
        expect(commitResult.finalization!.finalizedChapterReadStates.first.storyId, 'story-live-1');

        // 2. Status result parsing
        final jsonStatusWithFinalization = {
          'claimId': 'claim-1111',
          'status': 'COMMITTED',
          'expiresAt': '2026-10-14T10:15:00.000Z',
          'committedAt': '2026-10-14T10:00:00.000Z',
          'previewData': {
            'claimId': 'claim-1111',
            'status': 'COMMITTED',
            'stateFingerprint': 'a' * 64,
            'expiresAt': '2026-10-14T10:15:00.000Z',
            'bookmarksToImport': 1,
            'historyToImport': 2,
            'progressToImport': 1,
            'conflictsCount': 0,
            'readStatesIgnoredAntiResurrectionCount': 1,
          },
          'resultSummary': jsonWithFinalization['summary'],
          'finalization': jsonWithFinalization['finalization'],
        };

        final statusResult = GuestClaimStatusResult.fromJson(jsonStatusWithFinalization);
        expect(statusResult.status, GuestClaimStatus.committed);
        expect(statusResult.finalization, isNotNull);
        expect(statusResult.finalization!.tombstonedStoryIds, contains('story-dead-1'));
        expect(statusResult.finalization!.finalizedProgress.first.pageIndex, 15);
        expect(statusResult.finalization!.finalizedChapterReadStates.first.storyId, 'story-live-1');

        // 3. Backward compatibility: legacy committed claim without finalization field
        final jsonLegacy = {
          'claimId': 'claim-legacy',
          'status': 'COMMITTED',
          'committedAt': '2026-10-01T10:00:00.000Z',
          'summary': {
            'bookmarksImported': 0,
            'historyMerged': 0,
            'progressUpdated': 0,
            'conflictsResolved': 0,
          },
        };
        final legacyCommit = GuestClaimCommitResult.fromJson(jsonLegacy);
        expect(legacyCommit.finalization, isNull);
      });
    });
  });
}
