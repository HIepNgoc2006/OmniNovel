import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/core/errors/api_error.dart';
import 'package:omninovel_mobile/features/studio/models/studio_models.dart';
import 'package:omninovel_mobile/features/studio/presentation/controllers/studio_approval_controller.dart';
import 'package:omninovel_mobile/features/studio/repositories/studio_repository.dart';

class MockStudioRepository extends Mock implements StudioRepository {}

TranslationJobReviewDetailResponse buildDetail({
  String jobId = 'job-1',
  TranslationJobStatus status = TranslationJobStatus.readyForReview,
  bool canApply = true,
  String? applyBlockReason,
  int reviewRevision = 2,
  int materializedRevision = 2,
  int workspaceRevision = 5,
  String? targetVersionId = 'ver-target',
}) {
  return TranslationJobReviewDetailResponse(
    job: JobMetadata(
      id: jobId,
      status: status,
      progressPercentage: 100,
      provider: 'OPENAI',
      modelName: 'gpt-4o',
      promptVersion: 'v1.0',
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: DateTime.now(),
      reviewRevision: reviewRevision,
      materializedRevision: materializedRevision,
      workspaceRevision: workspaceRevision,
    ),
    context: TranslationJobContext(
      story: const StoryContext(id: 's1', title: 'Story', slug: 'story', mediaFormat: MediaFormat.comic),
      edition: const EditionContext(id: 'e1', editionName: 'Ed', language: 'vi', isDefault: true),
      chapter: const ChapterContext(id: 'c1', chapterNumber: '1'),
      project: const ProjectContext(id: 'p1', sourceLanguage: 'ja', targetLanguage: 'vi'),
      sourceVersion: const VersionContext(id: 'ver-src', versionNumber: 1),
      targetVersion: targetVersionId != null
          ? VersionContext(id: targetVersionId, versionNumber: 2)
          : null,
    ),
    reviewSummary: const ReviewSummaryDto(segmentCount: 10, verifiedCount: 10),
    permissions: JobPermissions(canApply: canApply, applyBlockReason: applyBlockReason),
  );
}

void main() {
  late MockStudioRepository mockRepository;

  setUpAll(() {
    registerFallbackValue(const ApplyTranslationJobRequest(mode: ApplyTranslationMode.overwriteActiveVersion));
  });

  setUp(() {
    mockRepository = MockStudioRepository();
  });

  group('Gate 4 & 5: Freshness Gate & Explicit Mode Selection', () {
    test('Gate 5: Initial mode is null and apply is disabled until user explicitly selects mode', () {
      final detail = buildDetail();
      final controller = StudioApprovalController(repository: mockRepository, initialJobDetail: detail);

      expect(controller.selectedMode, isNull);
      expect(controller.isApplyEnabled, isFalse);

      controller.selectMode(ApplyTranslationMode.overwriteActiveVersion);
      expect(controller.selectedMode, ApplyTranslationMode.overwriteActiveVersion);
      expect(controller.isApplyEnabled, isTrue);
    });

    test('Gate 4: Stale artifact (reviewRevision != materializedRevision) disables Apply CTA and does not POST', () async {
      final staleDetail = buildDetail(reviewRevision: 3, materializedRevision: 2);
      final controller = StudioApprovalController(repository: mockRepository, initialJobDetail: staleDetail);

      controller.selectMode(ApplyTranslationMode.overwriteActiveVersion);
      expect(controller.isFresh, isFalse);
      expect(controller.isApplyEnabled, isFalse);

      await controller.submitApply();

      // Zero POST calls verification
      verifyNever(() => mockRepository.applyJob(any(), any(), idempotencyKey: any(named: 'idempotencyKey')));
      expect(controller.status, StudioApprovalStatus.idle);
    });

    test('Gate 4: canApply false or block reason disables Apply CTA and does not POST', () async {
      final blockedDetail = buildDetail(canApply: false, applyBlockReason: 'INSUFFICIENT_ROLE');
      final controller = StudioApprovalController(repository: mockRepository, initialJobDetail: blockedDetail);

      controller.selectMode(ApplyTranslationMode.overwriteActiveVersion);
      expect(controller.isApplyEnabled, isFalse);

      await controller.submitApply();
      verifyNever(() => mockRepository.applyJob(any(), any(), idempotencyKey: any(named: 'idempotencyKey')));
    });
  });

  group('Gate 6: Frozen Idempotency & Ambiguous Recovery State Machine', () {
    test('Timeout in POST transitions to submissionOutcomeUnknown and preserves frozen identity', () async {
      final detail = buildDetail(workspaceRevision: 5);
      final controller = StudioApprovalController(repository: mockRepository, initialJobDetail: detail);
      controller.selectMode(ApplyTranslationMode.overwriteActiveVersion);

      const testKey = '550e8400-e29b-41d4-a716-446655440000';

      when(() => mockRepository.applyJob(
            'job-1',
            any(),
            idempotencyKey: testKey,
          )).thenThrow(ApiError.timeout());

      await controller.submitApply(testIdempotencyKey: testKey);

      expect(controller.status, StudioApprovalStatus.submissionOutcomeUnknown);
      expect(controller.frozenIdempotencyKey, testKey);
      expect(controller.frozenMode, ApplyTranslationMode.overwriteActiveVersion);
      expect(controller.canRetryAmbiguous, isTrue);

      // Mode cannot be changed while in ambiguous state
      controller.selectMode(ApplyTranslationMode.createAlternateVersion);
      expect(controller.selectedMode, ApplyTranslationMode.overwriteActiveVersion);
    });

    test('Ambiguity reconciliation with authoritative READY_FOR_REVIEW resets identity back to IDLE', () async {
      final detail = buildDetail(workspaceRevision: 5);
      final controller = StudioApprovalController(repository: mockRepository, initialJobDetail: detail);
      controller.selectMode(ApplyTranslationMode.overwriteActiveVersion);

      const testKey = '550e8400-e29b-41d4-a716-446655440000';

      when(() => mockRepository.applyJob('job-1', any(), idempotencyKey: testKey))
          .thenThrow(ApiError.timeout());

      await controller.submitApply(testIdempotencyKey: testKey);
      expect(controller.status, StudioApprovalStatus.submissionOutcomeUnknown);

      // Server confirms job is still READY_FOR_REVIEW (apply did not commit)
      when(() => mockRepository.getJobDetail('job-1'))
          .thenAnswer((_) async => buildDetail(status: TranslationJobStatus.readyForReview));

      await controller.reconcile();

      expect(controller.status, StudioApprovalStatus.idle);
      expect(controller.frozenIdempotencyKey, isNull);
      expect(controller.frozenMode, isNull);
      expect(controller.errorMessage, contains('chưa được áp dụng'));
    });

    test('Ambiguity reconciliation GET network failure keeps state at submissionOutcomeUnknown (does NOT fail)', () async {
      final detail = buildDetail(workspaceRevision: 5);
      final controller = StudioApprovalController(repository: mockRepository, initialJobDetail: detail);
      controller.selectMode(ApplyTranslationMode.overwriteActiveVersion);

      const testKey = '550e8400-e29b-41d4-a716-446655440000';

      when(() => mockRepository.applyJob('job-1', any(), idempotencyKey: testKey))
          .thenThrow(ApiError.timeout());

      await controller.submitApply(testIdempotencyKey: testKey);
      expect(controller.status, StudioApprovalStatus.submissionOutcomeUnknown);

      // GET reconciliation also times out
      when(() => mockRepository.getJobDetail('job-1'))
          .thenThrow(ApiError.timeout());

      await controller.reconcile();

      // Invariant: MUST NOT transition to failed!
      expect(controller.status, StudioApprovalStatus.submissionOutcomeUnknown);
      expect(controller.canRetryAmbiguous, isTrue);
    });
  });

  group('Gate 7: Authoritative Post-Apply Coherence Verification', () {
    test('POST 200 followed by valid reconciliation with APPLIED and advanced revision SUCCEEDS', () async {
      final initialDetail = buildDetail(workspaceRevision: 5, targetVersionId: null);
      final controller = StudioApprovalController(repository: mockRepository, initialJobDetail: initialDetail);
      controller.selectMode(ApplyTranslationMode.overwriteActiveVersion);

      const testKey = '550e8400-e29b-41d4-a716-446655440000';
      const applyRes = ApplyTranslationJobResponse(
        chapterId: 'c1',
        activeVersionId: 'ver-target',
        targetVersionId: 'ver-target',
        versionNumber: 2,
        versionType: 'TRANSLATED',
        isAlreadyApplied: false,
      );

      when(() => mockRepository.applyJob('job-1', any(), idempotencyKey: testKey))
          .thenAnswer((_) async => applyRes);

      // Server returns APPLIED with matched targetVersion and advanced workspaceRevision (6 > 5)
      final committedDetail = buildDetail(
        status: TranslationJobStatus.applied,
        workspaceRevision: 6,
        targetVersionId: 'ver-target',
      );
      when(() => mockRepository.getJobDetail('job-1')).thenAnswer((_) async => committedDetail);

      await controller.submitApply(testIdempotencyKey: testKey);

      expect(controller.status, StudioApprovalStatus.succeeded);
      expect(controller.errorMessage, isNull);
    });

    test('POST 200 followed by targetVersion mismatch triggers COMMITTED_RECONCILIATION_REQUIRED', () async {
      final initialDetail = buildDetail(workspaceRevision: 5, targetVersionId: null);
      final controller = StudioApprovalController(repository: mockRepository, initialJobDetail: initialDetail);
      controller.selectMode(ApplyTranslationMode.overwriteActiveVersion);

      const testKey = '550e8400-e29b-41d4-a716-446655440000';
      const applyRes = ApplyTranslationJobResponse(
        chapterId: 'c1',
        targetVersionId: 'ver-target-A',
        versionNumber: 2,
        versionType: 'TRANSLATED',
        isAlreadyApplied: false,
      );

      when(() => mockRepository.applyJob('job-1', any(), idempotencyKey: testKey))
          .thenAnswer((_) async => applyRes);

      // Server returns targetVersionId 'ver-target-B' (mismatch with response!)
      final mismatchedDetail = buildDetail(
        status: TranslationJobStatus.applied,
        workspaceRevision: 6,
        targetVersionId: 'ver-target-B',
      );
      when(() => mockRepository.getJobDetail('job-1')).thenAnswer((_) async => mismatchedDetail);

      await controller.submitApply(testIdempotencyKey: testKey);

      expect(controller.status, StudioApprovalStatus.committedReconciliationRequired);
      expect(controller.errorMessage, contains('Coherence Mismatch'));
    });

    test('POST 200 followed by non-advanced workspaceRevision triggers COMMITTED_RECONCILIATION_REQUIRED', () async {
      final initialDetail = buildDetail(workspaceRevision: 5, targetVersionId: null);
      final controller = StudioApprovalController(repository: mockRepository, initialJobDetail: initialDetail);
      controller.selectMode(ApplyTranslationMode.overwriteActiveVersion);

      const testKey = '550e8400-e29b-41d4-a716-446655440000';
      const applyRes = ApplyTranslationJobResponse(
        chapterId: 'c1',
        targetVersionId: 'ver-target-A',
        versionNumber: 2,
        versionType: 'TRANSLATED',
        isAlreadyApplied: false,
      );

      when(() => mockRepository.applyJob('job-1', any(), idempotencyKey: testKey))
          .thenAnswer((_) async => applyRes);

      // Server returns workspaceRevision: 5 (equal, not advanced!)
      final unadvancedDetail = buildDetail(
        status: TranslationJobStatus.applied,
        workspaceRevision: 5,
        targetVersionId: 'ver-target-A',
      );
      when(() => mockRepository.getJobDetail('job-1')).thenAnswer((_) async => unadvancedDetail);

      await controller.submitApply(testIdempotencyKey: testKey);

      expect(controller.status, StudioApprovalStatus.committedReconciliationRequired);
    });
  });
}
