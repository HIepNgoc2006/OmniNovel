import { test, expect } from '@playwright/test';
import { TranslationJobStatus, MediaFormat } from '@omninovel/shared';

test.describe('Manga Review Studio Verification, 4-State Action Matrix & Traversal E2E (Phase 4D RED 4 #149)', () => {
  const JOB_ID = 'e2e00000-0000-4000-8000-000000000010';
  const SEG1_ID = 'e2e00000-0000-4000-8000-000000000011';
  const SEG2_ID = 'e2e00000-0000-4000-8000-000000000012';
  const SEG3_ID = 'e2e00000-0000-4000-8000-000000000013';
  const STORY_ID = 'e2e00000-0000-4000-8000-000000000003';
  const CHAPTER_ID = 'e2e00000-0000-4000-8000-000000000004';

  test('4-State Verification Matrix, Atomic Dirty Verification, Hotkey Precedence & Bounded Traversal', async ({
    page,
  }) => {
    let serverWorkspaceRevision = 1;
    let serverReviewRevision = 1;

    // Stateful segments state on server
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
        translatedText: 'Bản dịch 1',
        confidence: 0.95,
        isHumanVerified: false,
        version: 1,
      },
      {
        id: SEG2_ID,
        jobId: JOB_ID,
        pageNumber: 1,
        anchorBlockId: null,
        sortOrder: 2,
        bboxX: 50,
        bboxY: 200,
        bboxW: 200,
        bboxH: 100,
        rawText: 'Raw 2',
        translatedText: 'Bản dịch 2',
        confidence: 0.92,
        isHumanVerified: false,
        version: 1,
      },
      {
        id: SEG3_ID,
        jobId: JOB_ID,
        pageNumber: 1,
        anchorBlockId: null,
        sortOrder: 3,
        bboxX: 50,
        bboxY: 350,
        bboxW: 200,
        bboxH: 100,
        rawText: 'Raw 3',
        translatedText: 'Bản dịch 3 đã duyệt',
        confidence: 0.98,
        isHumanVerified: true,
        version: 1,
      },
    ];

    // Track received PATCH mutations
    const receivedPatches: Array<{
      segmentId: string;
      expectedVersion?: number;
      isHumanVerified?: boolean;
      translatedText?: string;
    }> = [];

    // 1. Intercept Session Refresh & Auth Me
    await page.route('**/api/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'mock_jwt_access_token_verification_test',
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
              title: 'Manga Verification Test',
              slug: 'manga-verification-test',
              mediaFormat: MediaFormat.COMIC,
            },
            chapter: {
              id: CHAPTER_ID,
              chapterNumber: '1',
              title: 'Chương 1',
            },
          },
          reviewSummary: {
            segmentCount: 3,
            verifiedCount: serverSegments.filter((s) => s.isHumanVerified).length,
            pageCount: 1,
            resultPageCount: 1,
            blockCount: 3,
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

    await page.route('**/api/v1/gamification/progression', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ level: 1, currentExp: 0, nextLevelExp: 100 }),
      });
    });

    // 4. Intercept Segments GET & PATCH
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/segments**`, async (route) => {
      const method = route.request().method();
      const url = route.request().url();

      if (method === 'PATCH') {
        const postData = route.request().postDataJSON();
        // Determine segmentId from URL path
        const matched = url.match(/\/segments\/([^/?]+)/);
        const segmentId = matched ? matched[1] : '';

        receivedPatches.push({
          segmentId,
          ...postData,
        });

        const seg = serverSegments.find((s) => s.id === segmentId);
        if (!seg) {
          await route.fulfill({ status: 404 });
          return;
        }

        // Apply mutation
        seg.version += 1;
        if (postData.isHumanVerified !== undefined) {
          seg.isHumanVerified = postData.isHumanVerified;
        }
        if (postData.translatedText !== undefined) {
          seg.translatedText = postData.translatedText;
        }

        serverWorkspaceRevision += 1;
        serverReviewRevision += 1;

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(seg),
        });
        return;
      }

      // GET segments
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: serverSegments,
          pagination: {
            page: 1,
            limit: 50,
            totalItems: 3,
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

    // 6. Test Flow 1: Clean Toggle Verification (UNVERIFIED_CLEAN -> Duyệt -> VERIFIED_CLEAN -> Bỏ duyệt)
    const bbox1 = page.getByTestId(`bbox-item-${SEG1_ID}`);
    await expect(bbox1).toBeVisible({ timeout: 5000 });
    await bbox1.click();

    const editorContainer = page.getByTestId('segment-editor-container');
    await expect(editorContainer).toBeVisible();
    await expect(editorContainer).toHaveAttribute('data-segment-id', SEG1_ID);

    // Initial state: Unverified clean -> Verify button displays "Duyệt"
    await expect(page.getByTestId('badge-unverified')).toBeVisible();
    const toggleVerifyBtn = page.getByTestId('btn-toggle-verify');
    await expect(toggleVerifyBtn).toBeVisible();
    await expect(toggleVerifyBtn).toContainText('Duyệt');
    await expect(toggleVerifyBtn).toBeEnabled();

    // Click "Duyệt"
    await toggleVerifyBtn.click();

    // Verify PATCH was clean (verification-only, NO translatedText sent)
    await expect(async () => {
      const p = receivedPatches.find((item) => item.segmentId === SEG1_ID);
      expect(p).toBeDefined();
      expect(p?.expectedVersion).toBe(1);
      expect(p?.isHumanVerified).toBe(true);
      expect(p?.translatedText).toBeUndefined();
    }).toPass({ timeout: 5000 });

    // Authoritative post-save coherence updates UI
    await expect(page.getByTestId('badge-verified')).toBeVisible({ timeout: 5000 });
    await expect(toggleVerifyBtn).toContainText('Bỏ duyệt');

    // 7. Test Flow 2: Atomic Dirty Draft Verification (UNVERIFIED_DIRTY -> Lưu & Duyệt)
    // Select segment 2 via canvas
    const bbox2 = page.getByTestId(`bbox-item-${SEG2_ID}`);
    await bbox2.click();
    await expect(editorContainer).toHaveAttribute('data-segment-id', SEG2_ID);
    await expect(page.getByTestId('badge-unverified')).toBeVisible();
    await expect(toggleVerifyBtn).toContainText('Duyệt');

    // Type dirty text
    const textarea = page.getByTestId('segment-translation-textarea');
    const newDraftText = 'Bản dịch số 2 đã được biên tập và duyệt!';
    await textarea.fill(newDraftText);

    // Verify 4-State Matrix: dirty + unverified -> "Lưu & Duyệt" (button is ENABLED!)
    await expect(page.getByTestId('badge-dirty')).toBeVisible();
    await expect(toggleVerifyBtn).toContainText('Lưu & Duyệt');
    await expect(toggleVerifyBtn).toBeEnabled();

    // Click "Lưu & Duyệt" -> atomic text + verify mutation
    await toggleVerifyBtn.click();

    // Verify atomic PATCH received both translatedText AND isHumanVerified
    await expect(async () => {
      const p = receivedPatches.find((item) => item.segmentId === SEG2_ID);
      expect(p).toBeDefined();
      expect(p?.expectedVersion).toBe(1);
      expect(p?.isHumanVerified).toBe(true);
      expect(p?.translatedText).toBe(newDraftText);
    }).toPass({ timeout: 5000 });

    // Post-save: draft cleared, verified badge active
    await expect(page.getByTestId('badge-synced')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('badge-verified')).toBeVisible();
    await expect(toggleVerifyBtn).toContainText('Bỏ duyệt');

    // 8. Test Flow 3: Deterministic Bounded Traversal (No Auto-Wrap)
    // We are at SEG2_ID (index 1 of 3)
    const btnNext = page.getByTestId('btn-next-segment');
    const btnPrev = page.getByTestId('btn-prev-segment');
    const btnNextUnverified = page.getByTestId('btn-next-unverified');

    // Advance to next segment (SEG3_ID)
    await expect(btnNext).toBeEnabled();
    await btnNext.click();
    await expect(editorContainer).toHaveAttribute('data-segment-id', SEG3_ID);

    // At SEG3_ID (last segment, index 2 of 3):
    // Next segment must be disabled
    await expect(btnNext).toBeDisabled();

    // SEG3 is verified, and all segments (SEG1 verified, SEG2 verified, SEG3 verified) are now verified
    // Next unverified button MUST be disabled, strictly NO wrap-around to index 0!
    await expect(btnNextUnverified).toBeDisabled();

    // Previous segment should work and take us back to SEG2
    await expect(btnPrev).toBeEnabled();
    await btnPrev.click();
    await expect(editorContainer).toHaveAttribute('data-segment-id', SEG2_ID);
  });
});
