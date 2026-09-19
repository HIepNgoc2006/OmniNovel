import { test, expect } from '@playwright/test';
import { TranslationJobStatus } from '@omninovel/shared';

test.describe('Manga Review Studio Canvas & Layout Geometry E2E (Phase 4D RED 2)', () => {
  test('Wide-landscape image layout invariant: rendered source image plane exactly matches overlay plane', async ({
    page,
  }) => {
    // 1. Intercept Session Refresh & Auth Me
    await page.route('**/api/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'mock_jwt_access_token_canvas_test',
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

    // 2. Intercept Job Detail (READY_FOR_REVIEW)
    await page.route('**/api/v1/ai/jobs/test-job-canvas', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job: {
            id: 'test-job-canvas',
            status: TranslationJobStatus.READY_FOR_REVIEW,
            storyId: 'story-canvas-1',
            chapterId: 'chap-1',
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
            reviewRevision: 1,
            materializedRevision: 1,
            workspaceRevision: 1,
          },
          context: {
            story: {
              id: 'story-canvas-1',
              title: 'Manga Canvas Test',
              slug: 'manga-canvas-test',
              mediaFormat: 'COMIC',
            },
            chapter: {
              id: 'chap-1',
              chapterNumber: 1,
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

    // 3. Intercept Bounded Previews: Wide Landscape Image (2000x800)
    // Using SVG with explicit width/height ensures exact naturalWidth=2000, naturalHeight=800 in browser
    const wideSvgDataUrl =
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="800" viewBox="0 0 2000 800"><rect width="2000" height="800" fill="#1e293b"/></svg>'
      );

    await page.route('**/api/v1/ai/jobs/test-job-canvas/previews*', async (route) => {
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
              width: 2000,
              height: 800,
              url: wideSvgDataUrl,
            },
          ],
          resultAssets: [],
          workspaceRevision: 1,
        }),
      });
    });

    // 4. Intercept Page Segments
    await page.route('**/api/v1/ai/jobs/test-job-canvas/segments*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: 'seg-wide-1',
              jobId: 'test-job-canvas',
              pageNumber: 1,
              anchorBlockId: null,
              sortOrder: 1,
              bboxX: 1000, // 50% left
              bboxY: 400,  // 50% top
              bboxW: 500,  // 25% width
              bboxH: 200,  // 25% height
              rawText: 'Landscape raw',
              translatedText: 'Bản dịch phong cảnh',
              confidence: 0.98,
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

    // 5. Navigate to Studio Page with page 1
    await page.goto('/studio/ai/jobs/test-job-canvas?page=1');

    // 6. Verify image is rendered and loaded
    const sourceImg = page.getByTestId('canvas-source-image');
    await expect(sourceImg).toBeVisible({ timeout: 15000 });

    // Ensure decoded dimensions match authoritative 2000x800
    await expect(async () => {
      const naturalW = await sourceImg.evaluate((el: HTMLImageElement) => el.naturalWidth);
      const naturalH = await sourceImg.evaluate((el: HTMLImageElement) => el.naturalHeight);
      expect(naturalW).toBe(2000);
      expect(naturalH).toBe(800);
    }).toPass({ timeout: 5000 });

    // 7. Bounding box must appear on overlay
    const overlayContainer = page.getByTestId('canvas-overlay-container');
    const bboxItem = page.getByTestId('bbox-item-seg-wide-1');
    await expect(overlayContainer).toBeVisible();
    await expect(bboxItem).toBeVisible();

    // 8. CRITICAL GEOMETRY INVARIANT: Measure real browser bounding rectangles
    const imgRect = await sourceImg.boundingBox();
    const overlayRect = await overlayContainer.boundingBox();
    const bboxRect = await bboxItem.boundingBox();

    expect(imgRect).not.toBeNull();
    expect(overlayRect).not.toBeNull();
    expect(bboxRect).not.toBeNull();

    if (!imgRect || !overlayRect || !bboxRect) return;

    // A. The overlay coordinate plane MUST exactly match the rendered image plane (tolerating subpixel rounding <= 1.5px)
    expect(Math.abs(overlayRect.x - imgRect.x)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(overlayRect.y - imgRect.y)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(overlayRect.width - imgRect.width)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(overlayRect.height - imgRect.height)).toBeLessThanOrEqual(1.5);

    // B. The bounding box position must accurately align with image pixels (50% left, 50% top, 25% width, 25% height)
    const expectedBboxX = imgRect.x + imgRect.width * 0.5;
    const expectedBboxY = imgRect.y + imgRect.height * 0.5;
    const expectedBboxW = imgRect.width * 0.25;
    const expectedBboxH = imgRect.height * 0.25;

    expect(Math.abs(bboxRect.x - expectedBboxX)).toBeLessThanOrEqual(2.0);
    expect(Math.abs(bboxRect.y - expectedBboxY)).toBeLessThanOrEqual(2.0);
    expect(Math.abs(bboxRect.width - expectedBboxW)).toBeLessThanOrEqual(2.0);
    expect(Math.abs(bboxRect.height - expectedBboxH)).toBeLessThanOrEqual(2.0);
  });
});
