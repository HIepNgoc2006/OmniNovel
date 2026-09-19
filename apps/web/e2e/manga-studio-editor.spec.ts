import { test, expect } from '@playwright/test';
import { TranslationJobStatus, MediaFormat } from '@omninovel/shared';

test.describe('Manga Review Studio Editor, Draft Management & OCC E2E (Phase 4D RED 3 #149)', () => {
  const JOB_ID = 'e2e00000-0000-4000-8000-000000000001';
  const SEGMENT_ID = 'e2e00000-0000-4000-8000-000000000002';
  const STORY_ID = 'e2e00000-0000-4000-8000-000000000003';
  const CHAPTER_ID = 'e2e00000-0000-4000-8000-000000000004';

  test('Review Flow: select OCR bubble -> edit draft -> dirty badge -> save with OCC expectedVersion -> authoritative sync -> synced badge & canonical update', async ({
    page,
  }) => {
    // Stateful server revision state
    let serverWorkspaceRevision = 1;
    let serverReviewRevision = 1;
    let serverSegmentVersion = 1;
    let serverTranslatedText = 'Xin chào';



    // 1. Intercept Session Refresh & Auth Me
    await page.route('**/api/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'mock_jwt_access_token_editor_test',
        }),
      });
    });

    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'user-admin-1',
            username: 'admin',
            email: 'admin@omninovel.local',
            role: 'ADMIN',
          },
          permissions: {
            canCreateStory: true,
            canModerate: true,
            isAdmin: true,
          },
        }),
      });
    });

    // 2. Intercept Job Detail
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job: {
            id: JOB_ID,
            status: TranslationJobStatus.READY_FOR_REVIEW,
            storyId: STORY_ID,
            chapterId: CHAPTER_ID,
            sourceLanguage: 'ja',
            targetLanguage: 'vi',
            totalSteps: 10,
            completedSteps: 10,
            attemptCount: 1,
            maxAttempts: 3,
            createdAt: '2026-09-01T00:00:00.000Z',
            startedAt: '2026-09-01T00:01:00.000Z',
            heartbeatAt: '2026-09-01T00:05:00.000Z',
            completedAt: '2026-09-01T00:05:00.000Z',
            expiresAt: null,
            reviewRevision: serverReviewRevision,
            materializedRevision: 1,
            workspaceRevision: serverWorkspaceRevision,
          },
          context: {
            story: {
              id: STORY_ID,
              title: 'Manga Editor Test',
              slug: 'manga-editor-test',
              mediaFormat: MediaFormat.COMIC,
            },
            chapter: {
              id: CHAPTER_ID,
              chapterNumber: '1',
              title: 'Chương 1',
            },
          },
          reviewSummary: {
            segmentCount: 1,
            verifiedCount: 0,
            pageCount: 1,
            resultPageCount: 1,
            blockCount: 1,
          },
          permissions: {
            canApply: true,
          },
        }),
      });
    });

    // 3. Intercept Previews (Page 1 SVG)
    const svgDataUrl =
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1500" viewBox="0 0 1000 1500"><rect width="1000" height="1500" fill="#0f172a"/></svg>',
      );

    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/previews*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          fromPage: 1,
          toPage: 1,
          size: 1,
          sourceAssets: [
            {
              kind: 'SOURCE_REVIEW',
              pageNumber: 1,
              width: 1000,
              height: 1500,
              url: svgDataUrl,
            },
          ],
          resultAssets: [],
          workspaceRevision: serverWorkspaceRevision,
        }),
      });
    });

    // 4. Intercept Segments GET & PATCH
    let patchReceivedExpectedVersion: number | null = null;
    let patchReceivedTranslatedText: string | null = null;

    await page.route('**/api/v1/gamification/progression', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ level: 1, currentExp: 0, nextLevelExp: 100 }),
      });
    });

    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/segments**`, async (route) => {
      const method = route.request().method();

      if (method === 'PATCH') {
        const postData = route.request().postDataJSON();
        patchReceivedExpectedVersion = postData.expectedVersion;
        patchReceivedTranslatedText = postData.translatedText;

        // Advance authoritative state upon successful commit
        serverSegmentVersion = 2;
        serverWorkspaceRevision = 2;
        serverReviewRevision = 2;
        serverTranslatedText = postData.translatedText;

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: SEGMENT_ID,
            jobId: JOB_ID,
            pageNumber: 1,
            anchorBlockId: null,
            sortOrder: 1,
            bboxX: 100,
            bboxY: 150,
            bboxW: 400,
            bboxH: 200,
            rawText: 'こんにちは世界！',
            translatedText: serverTranslatedText,
            confidence: 0.96,
            isHumanVerified: false,
            version: serverSegmentVersion,
          }),
        });
        return;
      }

      // Default GET segments
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: SEGMENT_ID,
              jobId: JOB_ID,
              pageNumber: 1,
              anchorBlockId: null,
              sortOrder: 1,
              bboxX: 100,
              bboxY: 150,
              bboxW: 400,
              bboxH: 200,
              rawText: 'こんにちは世界！',
              translatedText: serverTranslatedText,
              confidence: 0.96,
              isHumanVerified: false,
              version: serverSegmentVersion,
            },
          ],
          pagination: {
            page: 1,
            limit: 50,
            totalItems: 1,
            totalPages: 1,
          },
          workspaceRevision: serverWorkspaceRevision,
        }),
      });
    });

    // 5. Navigate to Studio Page
    await page.goto(`/studio/ai/jobs/${JOB_ID}?page=1`);

    // Verify initial layout loaded
    const sourceImg = page.getByTestId('canvas-source-image');
    await expect(sourceImg).toBeVisible({ timeout: 15000 });

    // Empty state should be visible before selection
    await expect(page.getByTestId('segment-editor-empty')).toBeVisible();

    // 6. Click OCR bounding box on canvas to select segment
    const bboxItem = page.getByTestId(`bbox-item-${SEGMENT_ID}`);
    await expect(bboxItem).toBeVisible({ timeout: 5000 });
    await bboxItem.click();

    // 7. Verify Editor Container opens for selected segment
    const editorContainer = page.getByTestId('segment-editor-container');
    await expect(editorContainer).toBeVisible();
    await expect(editorContainer).toHaveAttribute('data-segment-id', SEGMENT_ID);

    // Initial state: textarea contains canonical text and badge is "Đồng bộ"
    const textarea = page.getByTestId('segment-translation-textarea');
    await expect(textarea).toHaveValue('Xin chào');
    await expect(page.getByTestId('badge-synced')).toBeVisible();
    await expect(page.getByTestId('btn-save-segment')).toBeDisabled();

    // 8. Type new translation
    const newTranslation = 'Xin chào bạn mới!';
    await textarea.fill(newTranslation);

    // Verify dirty state: badge-dirty appears and save button becomes enabled
    await expect(page.getByTestId('badge-dirty')).toBeVisible();
    const saveBtn = page.getByTestId('btn-save-segment');
    await expect(saveBtn).toBeEnabled();

    // 9. Click Save ("Lưu bản dịch")
    await saveBtn.click();

    // 10. Verify PATCH payload arrived with expected baseVersion = 1
    await expect(async () => {
      expect(patchReceivedExpectedVersion).toBe(1);
      expect(patchReceivedTranslatedText).toBe(newTranslation);
    }).toPass({ timeout: 5000 });

    // 11. Verify post-save authoritative reconciliation completes:
    // Dirty badge disappears, Synced badge reappears, and textarea displays updated text
    await expect(page.getByTestId('badge-synced')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('badge-dirty')).not.toBeVisible();
    await expect(textarea).toHaveValue(newTranslation);

    // 12. Segment list item also reflects updated canonical translation
    const segmentListItem = page.getByTestId(`segment-item-${SEGMENT_ID}`);
    await expect(segmentListItem).toContainText(newTranslation);
  });
});
