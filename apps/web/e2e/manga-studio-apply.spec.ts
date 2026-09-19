import { test, expect } from '@playwright/test';
import {
  TranslationJobStatus,
  MediaFormat,
  ApplyTranslationMode,
  ChapterVersionType,
} from '@omninovel/shared';

test.describe('Manga Review Studio Apply / Publish Protocol E2E (#152 Task 7)', () => {
  const JOB_ID = 'e2e00000-0000-4000-8000-000000000077';
  const STORY_ID = 'e2e00000-0000-4000-8000-000000000078';
  const CHAPTER_ID = 'e2e00000-0000-4000-8000-000000000079';
  const STORY_SLUG = 'test-manga-apply';

  test('Flow 1: Alternate version publish (CREATE_ALTERNATE_VERSION) -> modal opens -> selects alternate -> submits -> verifies Reader deep-link with ?versionId=', async ({
    page,
  }) => {
    let jobStatus: string = TranslationJobStatus.READY_FOR_REVIEW;
    let workspaceRevision = 1;
    let targetVersionId: string | null = null;
    let applyRequestedMode: string | null = null;
    let applyIdempotencyKey: string | null = null;

    // 1. Intercept Session Refresh & Auth Me
    await page.route('**/api/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'mock_jwt_access_token_apply_test',
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
            status: jobStatus,
            storyId: STORY_ID,
            chapterId: CHAPTER_ID,
            sourceLanguage: 'ja',
            targetLanguage: 'vi',
            attemptCount: 1,
            maxAttempts: 3,
            progressPercentage: 100,
            reviewRevision: 1,
            materializedRevision: 1,
            workspaceRevision,
            createdAt: '2026-09-01T00:00:00.000Z',
            startedAt: '2026-09-01T00:01:00.000Z',
            heartbeatAt: '2026-09-01T00:05:00.000Z',
            completedAt: '2026-09-01T00:05:00.000Z',
            expiresAt: null,
          },
          context: {
            story: {
              id: STORY_ID,
              title: 'Manga Apply Test',
              slug: STORY_SLUG,
              mediaFormat: MediaFormat.COMIC,
            },
            chapter: {
              id: CHAPTER_ID,
              chapterNumber: '1.00',
              title: 'Chương 1',
            },
            targetVersion: targetVersionId
              ? { id: targetVersionId, versionNumber: 2 }
              : null,
          },
          reviewSummary: {
            segmentCount: 1,
            verifiedCount: 1,
            pageCount: 1,
            resultPageCount: 1,
            blockCount: null,
          },
          permissions: {
            canApply: true,
          },
        }),
      });
    });

    // 3. Intercept Previews
    const sampleSvg =
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="1200" fill="#1e293b"/></svg>',
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
              width: 800,
              height: 1200,
              url: sampleSvg,
            },
          ],
          resultAssets: [
            {
              kind: 'RENDER_FINAL',
              pageNumber: 1,
              width: 800,
              height: 1200,
              url: sampleSvg,
            },
          ],
          workspaceRevision,
        }),
      });
    });

    // 4. Intercept Segments
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/segments*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'seg-apply-1',
              jobId: JOB_ID,
              pageNumber: 1,
              anchorBlockId: null,
              sortOrder: 1,
              bboxX: 50,
              bboxY: 50,
              bboxW: 200,
              bboxH: 100,
              rawText: 'こんにちは',
              translatedText: 'Xin chào',
              confidence: 0.99,
              isHumanVerified: true,
              version: 1,
            },
          ],
          pagination: {
            page: 1,
            limit: 50,
            totalItems: 1,
            totalPages: 1,
          },
          workspaceRevision,
        }),
      });
    });

    // 5. Intercept POST /apply
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/apply`, async (route) => {
      const postData = route.request().postDataJSON();
      applyRequestedMode = postData.mode;
      applyIdempotencyKey = route.request().headers()['idempotency-key'] || null;

      targetVersionId = 'ver-target-alt-77';
      jobStatus = TranslationJobStatus.APPLIED;
      workspaceRevision = 2;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chapterId: CHAPTER_ID,
          activeVersionId: 'ver-active-orig-1',
          targetVersionId,
          versionNumber: 2,
          versionType: ChapterVersionType.AI_TRANSLATED,
          isAlreadyApplied: false,
        }),
      });
    });

    // 6. Navigate to Studio Page
    await page.goto(`/studio/ai/jobs/${JOB_ID}?page=1`);

    // Verify Studio is loaded
    await expect(page.getByText('Manga Review Studio')).toBeVisible();
    await expect(page.getByText('READY_FOR_REVIEW')).toBeVisible();

    // 7. Verify Apply button is visible and enabled
    const applyBtn = page.getByTestId('btn-open-apply-modal');
    await expect(applyBtn).toBeVisible();
    await expect(applyBtn).toBeEnabled();

    // 8. Open modal
    await applyBtn.click();

    // Verify modal is open
    await expect(page.getByText('Chọn phương thức xuất bản:')).toBeVisible();

    // 9. Select CREATE_ALTERNATE_VERSION
    const altCard = page.getByTestId('mode-card-CREATE_ALTERNATE_VERSION');
    await altCard.click();

    // 10. Click Confirm Publish
    const confirmBtn = page.getByRole('button', { name: 'Xác Nhận Xuất Bản' });
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    // 11. Assert Success Screen in Modal
    await expect(page.getByText('Xuất bản thành công!')).toBeVisible();
    await expect(page.getByText('Phiên bản v2 đã sẵn sàng phục vụ độc giả.')).toBeVisible();

    // Verify reader link deep-link contains ?versionId=
    const readNowLink = page.getByRole('link', { name: 'Đọc chương này ngay' });
    await expect(readNowLink).toBeVisible();
    const href = await readNowLink.getAttribute('href');
    expect(href).toBe(`/stories/${STORY_SLUG}/read/${CHAPTER_ID}?versionId=${encodeURIComponent('ver-target-alt-77')}`);

    // Verify API contract received expected params
    expect(applyRequestedMode).toBe(ApplyTranslationMode.CREATE_ALTERNATE_VERSION);
    expect(applyIdempotencyKey).toBeTruthy();
  });

  test('Flow 2: Overwrite active version (OVERWRITE_ACTIVE_VERSION) -> modal opens -> selects overwrite -> submits -> transitions to APPLIED', async ({
    page,
  }) => {
    let jobStatus: string = TranslationJobStatus.READY_FOR_REVIEW;
    let workspaceRevision = 1;
    let targetVersionId: string | null = null;
    let applyRequestedMode: string | null = null;

    await page.route('**/api/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'mock_jwt_access_token_apply_test_2',
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

    await page.route(`**/api/v1/ai/jobs/${JOB_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job: {
            id: JOB_ID,
            status: jobStatus,
            storyId: STORY_ID,
            chapterId: CHAPTER_ID,
            sourceLanguage: 'ja',
            targetLanguage: 'vi',
            attemptCount: 1,
            maxAttempts: 3,
            progressPercentage: 100,
            reviewRevision: 1,
            materializedRevision: 1,
            workspaceRevision,
            createdAt: '2026-09-01T00:00:00.000Z',
            startedAt: '2026-09-01T00:01:00.000Z',
            heartbeatAt: '2026-09-01T00:05:00.000Z',
            completedAt: '2026-09-01T00:05:00.000Z',
            expiresAt: null,
          },
          context: {
            story: {
              id: STORY_ID,
              title: 'Manga Apply Test',
              slug: STORY_SLUG,
              mediaFormat: MediaFormat.COMIC,
            },
            chapter: {
              id: CHAPTER_ID,
              chapterNumber: '1.00',
              title: 'Chương 1',
            },
            targetVersion: targetVersionId
              ? { id: targetVersionId, versionNumber: 2 }
              : null,
          },
          reviewSummary: {
            segmentCount: 1,
            verifiedCount: 1,
            pageCount: 1,
            resultPageCount: 1,
            blockCount: null,
          },
          permissions: {
            canApply: true,
          },
        }),
      });
    });

    const sampleSvg =
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200"><rect width="800" height="1200" fill="#1e293b"/></svg>',
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
              width: 800,
              height: 1200,
              url: sampleSvg,
            },
          ],
          resultAssets: [
            {
              kind: 'RENDER_FINAL',
              pageNumber: 1,
              width: 800,
              height: 1200,
              url: sampleSvg,
            },
          ],
          workspaceRevision,
        }),
      });
    });

    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/segments*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'seg-apply-2',
              jobId: JOB_ID,
              pageNumber: 1,
              anchorBlockId: null,
              sortOrder: 1,
              bboxX: 50,
              bboxY: 50,
              bboxW: 200,
              bboxH: 100,
              rawText: 'こんにちは',
              translatedText: 'Xin chào',
              confidence: 0.99,
              isHumanVerified: true,
              version: 1,
            },
          ],
          pagination: {
            page: 1,
            limit: 50,
            totalItems: 1,
            totalPages: 1,
          },
          workspaceRevision,
        }),
      });
    });

    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/apply`, async (route) => {
      const postData = route.request().postDataJSON();
      applyRequestedMode = postData.mode;

      targetVersionId = 'ver-target-overwrite-88';
      jobStatus = TranslationJobStatus.APPLIED;
      workspaceRevision = 2;

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          chapterId: CHAPTER_ID,
          activeVersionId: targetVersionId,
          targetVersionId,
          versionNumber: 2,
          versionType: ChapterVersionType.AI_TRANSLATED,
          isAlreadyApplied: false,
        }),
      });
    });

    await page.goto(`/studio/ai/jobs/${JOB_ID}?page=1`);
    await expect(page.getByTestId('btn-open-apply-modal')).toBeVisible();

    await page.getByTestId('btn-open-apply-modal').click();
    await expect(page.getByText('Chọn phương thức xuất bản:')).toBeVisible();

    // Select OVERWRITE_ACTIVE_VERSION
    const overwriteCard = page.getByTestId('mode-card-OVERWRITE_ACTIVE_VERSION');
    await overwriteCard.click();

    // Confirm
    await page.getByRole('button', { name: 'Xác Nhận Xuất Bản' }).click();

    // Verify Success
    await expect(page.getByText('Xuất bản thành công!')).toBeVisible();
    expect(applyRequestedMode).toBe(ApplyTranslationMode.OVERWRITE_ACTIVE_VERSION);

    // Click "Ở lại Studio"
    await page.getByRole('button', { name: 'Ở lại Studio' }).click();
    await expect(page.getByText('Chọn phương thức xuất bản:')).not.toBeVisible();
  });
});
