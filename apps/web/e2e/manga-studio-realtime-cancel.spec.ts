import { test, expect } from '@playwright/test';
import { TranslationJobStatus, MediaFormat } from '@omninovel/shared';

test.describe('Manga Review Studio Realtime & Cancel Protocol E2E (#149 RED 6)', () => {
  const JOB_ID = 'e2e00000-0000-4000-8000-000000000009';
  const SEGMENT_ID = 'e2e00000-0000-4000-8000-000000000002';
  const STORY_ID = 'e2e00000-0000-4000-8000-000000000003';
  const CHAPTER_ID = 'e2e00000-0000-4000-8000-000000000004';

  test('Cancel Flow: Click Hủy Job -> confirm dialog -> POST /cancel -> authoritative transition to TERMINAL_STATE', async ({
    page,
  }) => {
    let jobStatus: string = TranslationJobStatus.READY_FOR_REVIEW;
    let cancelCalled = false;

    // 1. Intercept Session Refresh & Auth Me
    await page.route('**/api/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'mock_jwt_access_token_cancel_test',
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
            createdAt: '2026-09-01T00:00:00.000Z',
            startedAt: '2026-09-01T00:01:00.000Z',
            heartbeatAt: '2026-09-01T00:05:00.000Z',
            completedAt: '2026-09-01T00:05:00.000Z',
            expiresAt: null,
            reviewRevision: 1,
            materializedRevision: 1,
            workspaceRevision: 1,
          },
          context: {
            story: {
              id: STORY_ID,
              title: 'Manga Cancel Test',
              slug: 'manga-cancel-test',
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
    });

    // 3. Intercept Segments
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/segments*`, async (route) => {
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
              bboxX: 10,
              bboxY: 10,
              bboxW: 50,
              bboxH: 20,
              rawText: 'こんにちは',
              translatedText: 'Xin chào',
              confidence: 0.99,
              isHumanVerified: false,
              version: 1,
            },
          ],
          pagination: {
            page: 1,
            limit: 50,
            totalItems: 1,
            totalPages: 1,
          },
          workspaceRevision: 1,
        }),
      });
    });

    // 4. Intercept Previews
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/previews*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId: JOB_ID,
          workspaceRevision: 1,
          fromPage: 1,
          toPage: 1,
          totalPages: 1,
          sourceAssets: [
            {
              pageNumber: 1,
              url: 'https://cdn.example.com/source-1.webp',
              expiresAt: '2026-09-01T11:00:00Z',
              width: 800,
              height: 1200,
            },
          ],
          resultAssets: [
            {
              pageNumber: 1,
              url: 'https://cdn.example.com/result-1.webp',
              expiresAt: '2026-09-01T11:00:00Z',
              width: 800,
              height: 1200,
            },
          ],
        }),
      });
    });

    // 5. Intercept Cancel API
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/cancel`, async (route) => {
      cancelCalled = true;
      jobStatus = TranslationJobStatus.CANCELED;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: JOB_ID,
          status: TranslationJobStatus.CANCELED,
        }),
      });
    });

    // Handle confirm dialog automatically
    page.on('dialog', async (dialog) => {
      expect(dialog.message()).toContain('Bạn có chắc chắn muốn hủy');
      await dialog.accept();
    });

    // Navigate to job page
    await page.goto(`/studio/ai/jobs/${JOB_ID}`);

    // Wait for reviewable workspace to render
    const cancelBtn = page.getByTestId('btn-cancel-job');
    await expect(cancelBtn).toBeVisible({ timeout: 15000 });
    await expect(cancelBtn).toContainText('Hủy Job');

    // Check honest WebSocket badge
    const wsBadge = page.getByTestId('badge-ws-status');
    await expect(wsBadge).toBeVisible();

    // Click Hủy Job
    await cancelBtn.click();

    // Verify cancel was dispatched
    await expect.poll(() => cancelCalled).toBe(true);

    // Workspace must transition to TERMINAL_STATE
    await expect(page.getByRole('heading', { name: 'Job Dịch Đã Kết Thúc' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('CANCELED', { exact: true })).toBeVisible();
  });

  test('Cancel Race with Publisher Completion: 400 response resolves gracefully to APPLIED read-only view', async ({
    page,
  }) => {
    let jobStatus: string = TranslationJobStatus.READY_FOR_REVIEW;

    await page.route('**/api/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accessToken: 'mock_jwt_access_token_cancel_test' }),
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
            createdAt: '2026-09-01T00:00:00.000Z',
            startedAt: '2026-09-01T00:01:00.000Z',
            heartbeatAt: '2026-09-01T00:05:00.000Z',
            completedAt: '2026-09-01T00:05:00.000Z',
            expiresAt: null,
            reviewRevision: 1,
            materializedRevision: 1,
            workspaceRevision: 1,
          },
          context: {
            story: { id: STORY_ID, title: 'Manga Cancel Race', slug: 'manga-cancel-race', mediaFormat: MediaFormat.COMIC },
            chapter: { id: CHAPTER_ID, chapterNumber: '1', title: 'Chương 1' },
          },
          reviewSummary: { segmentCount: 1, verifiedCount: 0, pageCount: 1, resultPageCount: 1, blockCount: 1 },
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
              id: SEGMENT_ID,
              jobId: JOB_ID,
              pageNumber: 1,
              anchorBlockId: null,
              sortOrder: 1,
              bboxX: 10,
              bboxY: 10,
              bboxW: 50,
              bboxH: 20,
              rawText: 'こんにちは',
              translatedText: 'Xin chào',
              confidence: 0.99,
              isHumanVerified: false,
              version: 1,
            },
          ],
          pagination: { page: 1, limit: 50, totalItems: 1, totalPages: 1 },
          workspaceRevision: 1,
        }),
      });
    });

    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/previews*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jobId: JOB_ID,
          workspaceRevision: 1,
          fromPage: 1,
          toPage: 1,
          totalPages: 1,
          sourceAssets: [{ pageNumber: 1, url: 'https://cdn.example.com/source-1.webp', expiresAt: '2026-09-01T11:00:00Z', width: 800, height: 1200 }],
          resultAssets: [{ pageNumber: 1, url: 'https://cdn.example.com/result-1.webp', expiresAt: '2026-09-01T11:00:00Z', width: 800, height: 1200 }],
        }),
      });
    });

    // Cancel returns 400 because concurrently publisher finalized/applied the job
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/cancel`, async (route) => {
      jobStatus = TranslationJobStatus.APPLIED;
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'JOB_ALREADY_TERMINAL',
            message: 'Không thể hủy job đã ở trạng thái kết thúc (APPLIED).',
          },
        }),
      });
    });

    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    await page.goto(`/studio/ai/jobs/${JOB_ID}`);

    const cancelBtn = page.getByTestId('btn-cancel-job');
    await expect(cancelBtn).toBeVisible({ timeout: 15000 });

    await cancelBtn.click();

    // Must transition to APPLIED read-only view gracefully without crashing
    await expect(page.getByText('APPLIED', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Chỉ Đọc (Read-only)')).toBeVisible();
  });
});
