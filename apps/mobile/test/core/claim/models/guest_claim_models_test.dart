import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:omninovel_mobile/core/claim/models/guest_claim_models.dart';

void main() {
  group('Guest Claim Mirror Models & Conformance Tests', () {
    test('GuestClaimStatus maps canonical enum values correctly', () {
      expect(GuestClaimStatus.prepared.value, 'PREPARED');
      expect(GuestClaimStatus.committed.value, 'COMMITTED');
      expect(GuestClaimStatus.aborted.value, 'ABORTED');
      expect(GuestClaimStatus.expired.value, 'EXPIRED');

      expect(GuestClaimStatus.fromString('PREPARED'), GuestClaimStatus.prepared);
      expect(GuestClaimStatus.fromString('COMMITTED'), GuestClaimStatus.committed);
      expect(GuestClaimStatus.fromString('ABORTED'), GuestClaimStatus.aborted);
      expect(GuestClaimStatus.fromString('EXPIRED'), GuestClaimStatus.expired);
      expect(GuestClaimStatus.fromString('unknown_status'), GuestClaimStatus.prepared);
    });

    test('ConflictResolution maps canonical choices correctly', () {
      expect(ConflictResolution.keepCloud.value, 'KEEP_CLOUD');
      expect(ConflictResolution.useGuest.value, 'USE_GUEST');

      expect(ConflictResolution.fromString('KEEP_CLOUD'), ConflictResolution.keepCloud);
      expect(ConflictResolution.fromString('USE_GUEST'), ConflictResolution.useGuest);
      expect(ConflictResolution.fromString('random'), ConflictResolution.keepCloud);
    });

    test('ReadingMode normalizes MANGA_PAGED to PAGED (Invariant 13)', () {
      expect(ReadingMode.fromString('MANGA_PAGED'), ReadingMode.paged);
      expect(ReadingMode.fromString('manga_paged'), ReadingMode.paged);
      expect(ReadingMode.fromString('PAGED'), ReadingMode.paged);
      expect(ReadingMode.fromString('WEBTOON'), ReadingMode.webtoon);
      expect(ReadingMode.fromString('NOVEL'), ReadingMode.novel);
      expect(ReadingMode.fromString(null), ReadingMode.webtoon);

      expect(ReadingMode.paged.value, 'PAGED');
      expect(ReadingMode.webtoon.value, 'WEBTOON');
      expect(ReadingMode.novel.value, 'NOVEL');
    });

    test('GuestProgressItem enforces 1-based pageIndex >= 1 bound', () {
      final itemZero = GuestProgressItem(
        storyId: 'story-1',
        chapterId: 'chap-1',
        readingMode: ReadingMode.paged,
        pageIndex: 0,
        scrollPosition: 0.0,
        progressPercentage: 50.0,
      );
      expect(itemZero.pageIndex, 1);

      final itemNegative = GuestProgressItem(
        storyId: 'story-1',
        chapterId: 'chap-1',
        readingMode: ReadingMode.paged,
        pageIndex: -5,
        scrollPosition: 0.0,
        progressPercentage: 50.0,
      );
      expect(itemNegative.pageIndex, 1);

      final itemValid = GuestProgressItem(
        storyId: 'story-1',
        chapterId: 'chap-1',
        readingMode: ReadingMode.paged,
        pageIndex: 42,
        scrollPosition: 120.0,
        progressPercentage: 85.0,
      );
      expect(itemValid.pageIndex, 42);

      // JSON parsing normalizes MANGA_PAGED and enforces pageIndex >= 1
      final parsedFromJson = GuestProgressItem.fromJson({
        'storyId': 's-1',
        'chapterId': 'c-1',
        'readingMode': 'MANGA_PAGED',
        'pageIndex': 0,
        'scrollPosition': 0,
        'progressPercentage': 10,
      });
      expect(parsedFromJson.readingMode, ReadingMode.paged);
      expect(parsedFromJson.pageIndex, 1);
    });

    test('PrepareGuestClaimPayload JSON fixture serialization conforms to TypeScript contract', () {
      final payload = PrepareGuestClaimPayload(
        guestProfileId: '11111111-1111-4111-8111-111111111111',
        bookmarks: const [
          GuestBookmarkItem(
            storyId: '22222222-2222-4222-8222-222222222222',
            createdAt: '2026-10-07T12:00:00.000Z',
          ),
        ],
        history: const [
          GuestHistoryItem(
            storyId: '22222222-2222-4222-8222-222222222222',
            chapterId: '33333333-3333-4333-8333-333333333333',
            progressPercentage: 100.0,
            completedAt: '2026-10-07T12:30:00.000Z',
            lastReadAt: '2026-10-07T12:30:00.000Z',
          ),
        ],
        progress: [
          GuestProgressItem(
            storyId: '22222222-2222-4222-8222-222222222222',
            chapterId: '33333333-3333-4333-8333-333333333333',
            chapterVersionId: '44444444-4444-4444-8444-444444444444',
            readingMode: ReadingMode.paged,
            pageIndex: 15,
            scrollPosition: 0.0,
            progressPercentage: 75.0,
            updatedAt: '2026-10-07T12:45:00.000Z',
          ),
        ],
      );

      final jsonMap = payload.toJson();
      final jsonString = jsonEncode(jsonMap);

      expect(jsonMap['guestProfileId'], '11111111-1111-4111-8111-111111111111');
      expect((jsonMap['bookmarks'] as List).length, 1);
      expect((jsonMap['history'] as List).length, 1);
      expect((jsonMap['progress'] as List).length, 1);
      expect((jsonMap['progress'] as List)[0]['readingMode'], 'PAGED');
      expect((jsonMap['progress'] as List)[0]['pageIndex'], 15);

      final deserialized = PrepareGuestClaimPayload.fromJson(
        jsonDecode(jsonString) as Map<String, dynamic>,
      );
      expect(deserialized.guestProfileId, payload.guestProfileId);
      expect(deserialized.bookmarks.first.storyId, payload.bookmarks.first.storyId);
      expect(deserialized.history.first.progressPercentage, 100.0);
      expect(deserialized.progress.first.readingMode, ReadingMode.paged);
      expect(deserialized.progress.first.pageIndex, 15);
    });

    test('GuestClaimPreviewResult and Conflict models deserialize faithfully', () {
      final previewJson = {
        'claimId': '55555555-5555-4555-8555-555555555555',
        'status': 'PREPARED',
        'stateFingerprint': 'sha256_mock_fingerprint_0123456789',
        'expiresAt': '2026-10-07T13:00:00.000Z',
        'bookmarksToImport': 2,
        'historyToImport': 5,
        'progressToImport': 1,
        'conflictsCount': 1,
        'readStatesIgnoredAntiResurrectionCount': 0,
        'conflicts': [
          {
            'storyId': '22222222-2222-4222-8222-222222222222',
            'cloudProgress': {
              'storyId': '22222222-2222-4222-8222-222222222222',
              'chapterId': 'cloud-chap-1',
              'readingMode': 'PAGED',
              'pageIndex': 10,
              'scrollPosition': 0,
              'progressPercentage': 50.0,
              'updatedAt': '2026-10-06T10:00:00.000Z',
            },
            'guestProgress': {
              'storyId': '22222222-2222-4222-8222-222222222222',
              'chapterId': 'guest-chap-2',
              'readingMode': 'PAGED',
              'pageIndex': 25,
              'scrollPosition': 0,
              'progressPercentage': 80.0,
              'updatedAt': '2026-10-07T11:00:00.000Z',
            },
          }
        ],
      };

      final preview = GuestClaimPreviewResult.fromJson(previewJson);
      expect(preview.claimId, '55555555-5555-4555-8555-555555555555');
      expect(preview.status, GuestClaimStatus.prepared);
      expect(preview.conflictsCount, 1);
      expect(preview.conflicts.length, 1);
      expect(preview.conflicts.first.cloudProgress.chapterId, 'cloud-chap-1');
      expect(preview.conflicts.first.guestProgress.chapterId, 'guest-chap-2');
      expect(preview.conflicts.first.guestProgress.pageIndex, 25);
    });

    test('CommitGuestClaimPayload maps conflict decisions accurately', () {
      const payload = CommitGuestClaimPayload(
        conflictDecisions: {
          'story-a': ConflictResolution.useGuest,
          'story-b': ConflictResolution.keepCloud,
        },
      );

      final json = payload.toJson();
      expect(json['conflictDecisions'], {
        'story-a': 'USE_GUEST',
        'story-b': 'KEEP_CLOUD',
      });

      final deserialized = CommitGuestClaimPayload.fromJson(json);
      expect(deserialized.conflictDecisions['story-a'], ConflictResolution.useGuest);
      expect(deserialized.conflictDecisions['story-b'], ConflictResolution.keepCloud);
    });

    test('GuestClaimCommitResult and GuestClaimStatusResult roundtrip correctly', () {
      final commitResultJson = {
        'claimId': '66666666-6666-4666-8666-666666666666',
        'status': 'COMMITTED',
        'committedAt': '2026-10-07T12:50:00.000Z',
        'summary': {
          'bookmarksImported': 2,
          'historyMerged': 5,
          'progressUpdated': 1,
          'conflictsResolved': 1,
        },
      };

      final commitResult = GuestClaimCommitResult.fromJson(commitResultJson);
      expect(commitResult.status, GuestClaimStatus.committed);
      expect(commitResult.summary.bookmarksImported, 2);
      expect(commitResult.summary.historyMerged, 5);

      final statusResultJson = {
        'claimId': '66666666-6666-4666-8666-666666666666',
        'status': 'COMMITTED',
        'expiresAt': '2026-10-07T13:00:00.000Z',
        'committedAt': '2026-10-07T12:50:00.000Z',
        'previewData': {
          'claimId': '66666666-6666-4666-8666-666666666666',
          'status': 'COMMITTED',
          'stateFingerprint': 'test_fingerprint',
          'expiresAt': '2026-10-07T13:00:00.000Z',
          'bookmarksToImport': 2,
          'historyToImport': 5,
          'progressToImport': 1,
          'conflictsCount': 0,
          'readStatesIgnoredAntiResurrectionCount': 0,
          'conflicts': <Map<String, dynamic>>[],
        },
        'resultSummary': {
          'bookmarksImported': 2,
          'historyMerged': 5,
          'progressUpdated': 1,
          'conflictsResolved': 1,
        },
      };

      final statusResult = GuestClaimStatusResult.fromJson(statusResultJson);
      expect(statusResult.status, GuestClaimStatus.committed);
      expect(statusResult.resultSummary?.bookmarksImported, 2);
    });
  });
}
