import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:omninovel_mobile/features/studio/models/studio_models.dart';
import 'package:omninovel_mobile/features/studio/presentation/controllers/studio_approval_controller.dart';
import 'package:omninovel_mobile/features/studio/presentation/widgets/studio_apply_form_view.dart';
import 'package:omninovel_mobile/features/studio/presentation/widgets/studio_job_chooser_dialog.dart';
import 'package:omninovel_mobile/features/studio/repositories/studio_repository.dart';

class MockStudioRepository extends Mock implements StudioRepository {}

TranslationJobReviewDetailResponse buildDetail({
  bool canApply = true,
  String? applyBlockReason,
  int reviewRevision = 2,
  int materializedRevision = 2,
}) {
  return TranslationJobReviewDetailResponse(
    job: JobMetadata(
      id: 'job-1',
      status: TranslationJobStatus.readyForReview,
      progressPercentage: 100,
      provider: 'OPENAI',
      modelName: 'gpt-4o',
      promptVersion: 'v1.0',
      attemptCount: 1,
      maxAttempts: 3,
      createdAt: DateTime.now(),
      reviewRevision: reviewRevision,
      materializedRevision: materializedRevision,
      workspaceRevision: 5,
    ),
    context: const TranslationJobContext(
      story: StoryContext(id: 's1', title: 'Test Story', slug: 'test-story', mediaFormat: MediaFormat.comic),
      edition: EditionContext(id: 'e1', editionName: 'Vi Edition', language: 'vi', isDefault: true),
      chapter: ChapterContext(id: 'c1', chapterNumber: '1', title: 'Chapter Title'),
      project: ProjectContext(id: 'p1', sourceLanguage: 'ja', targetLanguage: 'vi'),
      sourceVersion: VersionContext(id: 'src-1', versionNumber: 1),
      targetVersion: null,
    ),
    reviewSummary: const ReviewSummaryDto(segmentCount: 20, verifiedCount: 20, pageCount: 5),
    permissions: JobPermissions(canApply: canApply, applyBlockReason: applyBlockReason),
  );
}

void main() {
  late MockStudioRepository mockRepository;

  setUp(() {
    mockRepository = MockStudioRepository();
  });

  Widget wrapWithMaterial(Widget child) {
    return MaterialApp(
      home: Scaffold(
        body: child,
      ),
    );
  }

  group('Gate 2, 4, 5 Widget Tests (StudioApplyFormView)', () {
    testWidgets('Gate 2: Disabled with INSUFFICIENT_ROLE warning when canApply is false', (tester) async {
      final detail = buildDetail(canApply: false, applyBlockReason: 'INSUFFICIENT_ROLE');
      final controller = StudioApprovalController(repository: mockRepository, initialJobDetail: detail);

      await tester.pumpWidget(wrapWithMaterial(StudioApplyFormView(controller: controller)));
      await tester.pump();

      expect(find.textContaining('Bạn không có quyền áp dụng bản dịch'), findsOneWidget);
      expect(find.textContaining('INSUFFICIENT_ROLE'), findsOneWidget);

      final buttonFinder = find.byType(ElevatedButton);
      expect(buttonFinder, findsOneWidget);
      final elevatedButton = tester.widget<ElevatedButton>(buttonFinder);
      expect(elevatedButton.onPressed, isNull); // Button disabled!
    });

    testWidgets('Gate 4: Shows Stale warning when reviewRevision != materializedRevision', (tester) async {
      final detail = buildDetail(reviewRevision: 3, materializedRevision: 2);
      final controller = StudioApprovalController(repository: mockRepository, initialJobDetail: detail);

      await tester.pumpWidget(wrapWithMaterial(StudioApplyFormView(controller: controller)));
      await tester.pump();

      expect(find.textContaining('Bản dịch đang được cập nhật/materialize lại'), findsOneWidget);
      final buttonFinder = find.byType(ElevatedButton);
      final elevatedButton = tester.widget<ElevatedButton>(buttonFinder);
      expect(elevatedButton.onPressed, isNull);
    });

    testWidgets('Gate 5: Button disabled until explicit mode selection', (tester) async {
      final detail = buildDetail(canApply: true);
      final controller = StudioApprovalController(repository: mockRepository, initialJobDetail: detail);

      await tester.pumpWidget(wrapWithMaterial(StudioApplyFormView(controller: controller)));
      await tester.pump();

      expect(controller.selectedMode, isNull);
      var button = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(button.onPressed, isNull);
      expect(find.text('Vui lòng chọn chế độ xuất bản'), findsOneWidget);

      // Tap Overwrite mode card
      await tester.tap(find.textContaining('Ghi đè phiên bản chính'));
      await tester.pump();

      expect(controller.selectedMode, ApplyTranslationMode.overwriteActiveVersion);
      button = tester.widget<ElevatedButton>(find.byType(ElevatedButton));
      expect(button.onPressed, isNotNull);
      expect(find.text('Xác nhận & Xuất bản'), findsOneWidget);
    });
  });

  group('Gate 8: StudioJobChooserDialog Tests', () {
    testWidgets('Displays all jobs and invokes callback on selection', (tester) async {
      final jobs = [
        TranslationJobSummaryDto(
          id: 'job-1',
          chapterId: 'c1',
          chapterNumber: '1',
          status: TranslationJobStatus.readyForReview,
          targetLanguage: 'vi',
          modelName: 'gpt-4o',
          completedAt: DateTime(2026, 9, 28, 12, 0),
        ),
        TranslationJobSummaryDto(
          id: 'job-2',
          chapterId: 'c1',
          chapterNumber: '1',
          status: TranslationJobStatus.readyForReview,
          targetLanguage: 'en',
          modelName: 'claude-3-5-sonnet',
          completedAt: DateTime(2026, 9, 28, 11, 30),
        ),
      ];

      TranslationJobSummaryDto? selectedJob;

      await tester.pumpWidget(wrapWithMaterial(
        StudioJobChooserDialog(
          chapterNumber: '1',
          jobs: jobs,
          onJobSelected: (job) => selectedJob = job,
        ),
      ));
      await tester.pump();

      expect(find.textContaining('Chương 1 có 2 bản dịch AI'), findsOneWidget);
      expect(find.textContaining('Bản dịch tiếng VI (gpt-4o)'), findsOneWidget);
      expect(find.textContaining('Bản dịch tiếng EN (claude-3-5-sonnet)'), findsOneWidget);

      await tester.tap(find.textContaining('Bản dịch tiếng VI (gpt-4o)'));
      await tester.pump();

      expect(selectedJob?.id, 'job-1');
    });
  });
}
