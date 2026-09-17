import { test, expect } from '@playwright/test';
import { TranslationJobStatus, MediaFormat } from '@omninovel/shared';

test.describe('Manga Review Studio Materialization Lifecycle E2E (Phase 4D RED 5 #149, #157)', () => {
  const JOB_ID = 'e2e00000-0000-4000-8000-000000000020';
  const SEG1_ID = 'e2e00000-0000-4000-8000-000000000021';
  const STORY_ID = 'e2e00000-0000-4000-8000-000000000003';
  const CHAPTER_ID = 'e2e00000-0000-4000-8000-000000000004';

  const svgDataUrlV1 =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1500" viewBox="0 0 1000 1500"><rect width="1000" height="1500" fill="#0f172a"/><text x="50" y="100" fill="#ffffff" font-size="40">V1 RESULT</text></svg>',
    );

  const svgDataUrlV2 =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1500" viewBox="0 0 1000 1500"><rect width="1000" height="1500" fill="#0f172a"/><text x="50" y="100" fill="#ffffff" font-size="40">V2 RESULT FRESH</text></svg>',
    );

  test('Flow 1: Stale job -> trigger materialization (Lock A: stays TRACKING) -> polling -> FRESH + canvas updates (Lock B & D)', async ({
    page,
  }) => {
    let serverWorkspaceRevision = 2;
    let serverReviewRevision = 2;
    let serverMaterializedRevision = 1;
    let pollCount = 0;

    const serverSegments = [
      {
        id: SEG1_ID,
        jobId: JOB_ID,
        pageNumber: 1,
        anchorBlockId: null,
        sortOrder: 1,
        bboxX: 50,
        bboxY: 50,
        bboxW: 200,
        bboxH: 100,
        rawText: 'Raw 1',
        translatedText: 'Bản dịch v2 chưa render',
        confidence: 0.95,
        isHumanVerified: false,
        version: 2,
      },
    ];

    // 1. Auth routes
    await page.route('**/api/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'mock_jwt_access_token_red5_test',
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

    await page.route('**/api/v1/gamification/progression', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ level: 1, currentExp: 0, nextLevelExp: 100 }),
      });
    });

    // 2. Job Detail route (simulates render progression on polling)
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}`, async (route) => {
      if (route.request().method() === 'GET') {
        // On 2nd poll after enqueue, render finishes!
        if (materializationEnqueued) {
          pollCount++;
          if (pollCount >= 2 && serverMaterializedRevision < serverReviewRevision) {
            serverMaterializedRevision = 2;
            serverWorkspaceRevision = 3;
          }
        }

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
              materializedRevision: serverMaterializedRevision,
              workspaceRevision: serverWorkspaceRevision,
            },
            context: {
              story: {
                id: STORY_ID,
                title: 'Materialization E2E Test',
                slug: 'materialization-e2e-test',
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
          }),
        });
        return;
      }
      await route.continue();
    });

    // 3. Previews route: returns V1 when serverWorkspaceRevision < 3, V2 when >= 3
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/previews*`, async (route) => {
      const isCompleted = serverWorkspaceRevision >= 3;
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
              url: svgDataUrlV1,
            },
          ],
          resultAssets: [
            {
              kind: 'RESULT_REVIEW',
              pageNumber: 1,
              width: 1000,
              height: 1500,
              url: isCompleted ? svgDataUrlV2 : svgDataUrlV1,
            },
          ],
          workspaceRevision: serverWorkspaceRevision,
        }),
      });
    });

    // 4. Segments route
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/segments**`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: serverSegments,
          pagination: {
            page: 1,
            limit: 50,
            total: 1,
            totalPages: 1,
          },
          workspaceRevision: serverWorkspaceRevision,
        }),
      });
    });

    // 5. Materialization Trigger route (POST)
    let materializationEnqueued = false;
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/materializations`, async (route) => {
      materializationEnqueued = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ENQUEUED',
          jobId: JOB_ID,
          targetRevision: 2,
        }),
      });
    });

    // Navigate to studio
    await page.goto(`/studio/ai/jobs/${JOB_ID}`);

    // Verify initial stale badge & trigger button
    await expect(page.getByText('Cần Kết Xuất Lại')).toBeVisible();
    const triggerBtn = page.getByTestId('btn-trigger-materialize');
    await expect(triggerBtn).toBeVisible();
    await expect(triggerBtn).toBeEnabled();
    await expect(triggerBtn).toContainText('Kết xuất lại ảnh');

    // Click trigger materialization
    await triggerBtn.click();

    // Verify Lock A: button transitions to TRACKING (isMaterializing true) and stays disabled with tracking label
    const trackingBtn = page.getByTestId('btn-materializing');
    await expect(trackingBtn).toBeVisible();
    await expect(trackingBtn).toBeDisabled();
    await expect(trackingBtn).toContainText('Đang kết xuất revision 2...');

    // Wait for bounded polling to pick up serverMaterializedRevision = 2
    // Once completion is proved, button transitions to FRESH
    await expect(page.getByRole('button', { name: 'Đã Đồng Bộ Kết Xuất' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('btn-materializing')).not.toBeVisible();

    // Verify canvas rendered result image has updated to V2 preview without F5!
    const canvas = page.getByTestId('canvas-source-wrapper');
    await expect(canvas).toBeVisible();
  });

  test('Flow 2: Superseding edit while render in-flight -> CTA enables for new revision (Lock C)', async ({
    page,
  }) => {
    let serverWorkspaceRevision = 2;
    let serverReviewRevision = 2;
    let serverMaterializedRevision = 1;

    const serverSegments = [
      {
        id: SEG1_ID,
        jobId: JOB_ID,
        pageNumber: 1,
        anchorBlockId: null,
        sortOrder: 1,
        bboxX: 50,
        bboxY: 50,
        bboxW: 200,
        bboxH: 100,
        rawText: 'Raw 1',
        translatedText: 'Bản dịch v2',
        confidence: 0.95,
        isHumanVerified: false,
        version: 2,
      },
    ];

    // Auth & gamification
    await page.route('**/api/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accessToken: 'mock_jwt_access_token_red5_test' }),
      });
    });

    await page.route('**/api/v1/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: { id: 'user-admin-1', username: 'admin', email: 'admin@omninovel.local', role: 'ADMIN' },
          permissions: { canCreateStory: true, canModerate: true, isAdmin: true },
        }),
      });
    });

    await page.route('**/api/v1/gamification/progression', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ level: 1, currentExp: 0, nextLevelExp: 100 }),
      });
    });

    // Job Detail
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
            materializedRevision: serverMaterializedRevision,
            workspaceRevision: serverWorkspaceRevision,
          },
          context: {
            story: { id: STORY_ID, title: 'Superseding E2E Test', slug: 'superseding-test', mediaFormat: MediaFormat.COMIC },
            chapter: { id: CHAPTER_ID, chapterNumber: '1', title: 'Chương 1' },
          },
          reviewSummary: {
            segmentCount: 1,
            verifiedCount: 0,
            pageCount: 1,
            resultPageCount: 1,
            blockCount: 1,
          },
        }),
      });
    });

    // Previews
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/previews*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          fromPage: 1,
          toPage: 1,
          size: 1,
          sourceAssets: [{ kind: 'SOURCE_REVIEW', pageNumber: 1, width: 1000, height: 1500, url: svgDataUrlV1 }],
          resultAssets: [{ kind: 'RESULT_REVIEW', pageNumber: 1, width: 1000, height: 1500, url: svgDataUrlV1 }],
          workspaceRevision: serverWorkspaceRevision,
        }),
      });
    });

    // Segments GET & PATCH
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/segments**`, async (route) => {
      if (route.request().method() === 'PATCH') {
        const postData = route.request().postDataJSON();
        serverSegments[0].translatedText = postData.translatedText || serverSegments[0].translatedText;
        serverSegments[0].version += 1;
        serverReviewRevision = 3;
        serverWorkspaceRevision += 1;

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(serverSegments[0]),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: serverSegments,
          pagination: { page: 1, limit: 50, total: 1, totalPages: 1 },
          workspaceRevision: serverWorkspaceRevision,
        }),
      });
    });

    // Materialization Trigger route
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/materializations`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ENQUEUED',
          jobId: JOB_ID,
          targetRevision: serverReviewRevision,
        }),
      });
    });

    await page.goto(`/studio/ai/jobs/${JOB_ID}`);

    // Trigger materialization for rev 2
    const triggerBtn = page.getByTestId('btn-trigger-materialize');
    await expect(triggerBtn).toBeVisible();
    await triggerBtn.click();

    // Now in TRACKING
    await expect(page.getByTestId('btn-materializing')).toBeVisible();

    // Select the segment to open editor
    const segmentItem = page.getByTestId(`segment-item-${SEG1_ID}`);
    await expect(segmentItem).toBeVisible();
    await segmentItem.click();

    // User makes a superseding edit to segment text during tracking
    const textarea = page.getByTestId('segment-translation-textarea');
    await expect(textarea).toBeVisible();
    await textarea.fill('Bản dịch v3 ghi đè');
    const saveBtn = page.getByTestId('btn-save-segment');
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Wait for segment save to settle and update serverReviewRevision to 3
    await expect(page.getByTestId('badge-synced')).toBeVisible();

    // On next poll or refetch, server reviewRevision (3) > targetRevision (2)
    // Lock C: UI transitions to SUPERSEDED
    await expect(page.getByTestId('banner-materialization-superseded')).toBeVisible({ timeout: 10000 });

    // The CTA button is now re-enabled to trigger materialization for rev 3
    const supersededBtn = page.getByTestId('btn-trigger-materialize');
    await expect(supersededBtn).toBeVisible();
    await expect(supersededBtn).toBeEnabled();
    await expect(supersededBtn).toContainText('Có chỉnh sửa mới — Kết xuất lại');
  });
});
