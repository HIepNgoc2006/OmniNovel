import { test, expect } from '@playwright/test';
import { TranslationJobStatus, MediaFormat } from '@omninovel/shared';

test.describe('Novel Review Studio E2E Suite (#150)', () => {
  const JOB_ID = 'e2e00000-0000-4000-8000-000000000150';
  const SEGMENT_ID_1 = 'e2e00000-0000-4000-8000-000000000151';
  const SEGMENT_ID_2 = 'e2e00000-0000-4000-8000-000000000152';
  const STORY_ID = 'e2e00000-0000-4000-8000-000000000153';
  const CHAPTER_ID = 'e2e00000-0000-4000-8000-000000000154';

  test.beforeEach(async ({ page }) => {
    // Intercept Session Refresh & Auth Me
    await page.route('**/api/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'mock_jwt_access_token_novel_test',
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
            username: 'novel_editor',
            email: 'editor@omninovel.local',
            role: 'TRANSLATOR',
          },
          permissions: {
            canCreateStory: true,
            canModerate: true,
            isAdmin: false,
          },
        }),
      });
    });
  });

  test('Flow A: Happy path - edit text preserving protected anchors -> OCC save -> toggle verification', async ({
    page,
  }) => {
    let segmentVersion = 1;
    let translatedText = 'Chào mừng ⟦S:0001⟧Ainz⟦/S:0001⟧ đã trở lại.';
    let isHumanVerified = false;
    let patchPayloadReceived: any = null;

    // 1. Intercept Job Detail (NOVEL mediaFormat)
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
            totalSteps: 5,
            completedSteps: 5,
            attemptCount: 1,
            maxAttempts: 3,
            createdAt: '2026-09-20T00:00:00.000Z',
            startedAt: '2026-09-20T00:01:00.000Z',
            heartbeatAt: '2026-09-20T00:05:00.000Z',
            completedAt: '2026-09-20T00:05:00.000Z',
            expiresAt: null,
            reviewRevision: 1,
            materializedRevision: 1,
            workspaceRevision: 1,
          },
          context: {
            story: {
              id: STORY_ID,
              title: 'Overlord Light Novel (E2E Test)',
              slug: 'overlord-ln-test',
              mediaFormat: MediaFormat.NOVEL,
            },
            chapter: {
              id: CHAPTER_ID,
              chapterNumber: '1.00',
              title: 'Hồi Kết và Khởi Đầu',
            },
            edition: {
              id: 'e1',
              editionName: 'Bản Dịch Chuẩn',
              language: 'vi',
              isDefault: true,
            },
            project: { id: 'p1', sourceLanguage: 'ja', targetLanguage: 'vi' },
            sourceVersion: { id: 'v1', versionNumber: 1 },
            targetVersion: null,
          },
          reviewSummary: {
            segmentCount: 1,
            verifiedCount: isHumanVerified ? 1 : 0,
            pageCount: null,
            resultPageCount: null,
            blockCount: 1,
          },
          permissions: {
            canApply: false,
          },
        }),
      });
    });

    // 2. Intercept Segments List
    await page.route(`**/api/v1/ai/jobs/${JOB_ID}/segments*`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: SEGMENT_ID_1,
              jobId: JOB_ID,
              pageNumber: null,
              anchorBlockId: 'p-1',
              sortOrder: 1,
              bboxX: null,
              bboxY: null,
              bboxW: null,
              bboxH: null,
              rawText: 'ようこそ⟦S:0001⟧アインズ様⟦/S:0001⟧お帰りなさいませ。',
              translatedText,
              confidence: 0.99,
              isHumanVerified,
              version: segmentVersion,
            },
          ],
          pagination: { page: 1, limit: 200, total: 1, totalPages: 1 },
          workspaceRevision: 1,
        }),
      });
    });

    // 3. Intercept Segment Mutation PATCH
    await page.route(
      `**/api/v1/ai/jobs/${JOB_ID}/segments/${SEGMENT_ID_1}`,
      async (route) => {
        if (route.request().method() === 'PATCH') {
          patchPayloadReceived = route.request().postDataJSON();
          if (patchPayloadReceived.translatedText !== undefined) {
            translatedText = patchPayloadReceived.translatedText;
            segmentVersion += 1;
            isHumanVerified = false;
          }
          if (patchPayloadReceived.isHumanVerified !== undefined) {
            isHumanVerified = patchPayloadReceived.isHumanVerified;
            segmentVersion += 1;
          }

          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              id: SEGMENT_ID_1,
              jobId: JOB_ID,
              pageNumber: null,
              anchorBlockId: 'p-1',
              sortOrder: 1,
              bboxX: null,
              bboxY: null,
              bboxW: null,
              bboxH: null,
              rawText: 'ようこそ⟦S:0001⟧アインズ様⟦/S:0001⟧お帰りなさいませ。',
              translatedText,
              confidence: 0.99,
              isHumanVerified,
              version: segmentVersion,
            }),
          });
          return;
        }
        await route.fallback();
      },
    );

    // Navigate to Novel Studio route
    await page.goto(`/studio/ai/jobs/${JOB_ID}`);

    // Verify Novel Workspace loaded
    await expect(page.getByTestId('novel-review-workspace')).toBeVisible();
    await expect(page.getByText('Overlord Light Novel (E2E Test)')).toBeVisible();

    // Verify initial CLEAN badge and version
    const stateBadge = page.getByTestId('novel-segment-state-badge');
    await expect(stateBadge).toHaveText('CLEAN');
    await expect(page.getByText('v1')).toBeVisible();

    // Edit textarea preserving anchors
    const textarea = page.getByTestId(`novel-segment-textarea-${SEGMENT_ID_1}`);
    await textarea.fill('Kính chào ⟦S:0001⟧Đại nhân Ainz⟦/S:0001⟧ đã quang lâm.');

    // State becomes DIRTY
    await expect(stateBadge).toHaveText('DIRTY');

    // Click Save button
    const saveBtn = page.getByTestId(`novel-segment-save-btn-${SEGMENT_ID_1}`);
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // Verify PATCH payload invariant: only translatedText and expectedVersion
    await expect.poll(() => patchPayloadReceived).not.toBeNull();
    expect(patchPayloadReceived).toEqual({
      translatedText: 'Kính chào ⟦S:0001⟧Đại nhân Ainz⟦/S:0001⟧ đã quang lâm.',
      expectedVersion: 1,
      isHumanVerified: false,
    });

    // Invariant: payload builder NEVER leaks immutable fields
    expect(patchPayloadReceived.rawText).toBeUndefined();
    expect(patchPayloadReceived.anchorBlockId).toBeUndefined();
    expect(patchPayloadReceived.sortOrder).toBeUndefined();
    expect(patchPayloadReceived.id).toBeUndefined();
    expect(patchPayloadReceived.jobId).toBeUndefined();

    // Verify updated state and version v2
    await expect(stateBadge).toHaveText('CLEAN');
    await expect(page.getByText('v2')).toBeVisible();

    // Toggle Verify
    const verifyBtn = page.getByTestId(
      `novel-segment-verify-btn-${SEGMENT_ID_1}`,
    );
    await verifyBtn.click();

    await expect(page.getByText('Đã duyệt')).toBeVisible();
    await expect(page.getByText('v3')).toBeVisible();
  });

  test('Flow B1: Client UX Gate - Corrupted anchor disables Save and blocks PATCH (PATCH count = 0)', async ({
    page,
  }) => {
    let patchCount = 0;

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
            totalSteps: 5,
            completedSteps: 5,
            attemptCount: 1,
            maxAttempts: 3,
            createdAt: '2026-09-20T00:00:00.000Z',
            startedAt: '2026-09-20T00:01:00.000Z',
            heartbeatAt: '2026-09-20T00:05:00.000Z',
            completedAt: '2026-09-20T00:05:00.000Z',
            expiresAt: null,
            reviewRevision: 1,
            materializedRevision: 1,
            workspaceRevision: 1,
          },
          context: {
            story: {
              id: STORY_ID,
              title: 'Anchor Guard Test',
              slug: 'anchor-guard-test',
              mediaFormat: MediaFormat.NOVEL,
            },
            chapter: {
              id: CHAPTER_ID,
              chapterNumber: '1.00',
              title: 'Chương 1',
            },
            edition: {
              id: 'e1',
              editionName: 'Bản Dịch',
              language: 'vi',
              isDefault: true,
            },
            project: { id: 'p1', sourceLanguage: 'ja', targetLanguage: 'vi' },
            sourceVersion: { id: 'v1', versionNumber: 1 },
            targetVersion: null,
          },
          reviewSummary: {
            segmentCount: 1,
            verifiedCount: 0,
            pageCount: null,
            resultPageCount: null,
            blockCount: 1,
          },
          permissions: { canApply: false },
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
              id: SEGMENT_ID_1,
              jobId: JOB_ID,
              pageNumber: null,
              anchorBlockId: 'p-1',
              sortOrder: 1,
              bboxX: null,
              bboxY: null,
              bboxW: null,
              bboxH: null,
              rawText: 'Ngươi có phải ⟦S:0001⟧Chúa tể⟦/S:0001⟧ không?',
              translatedText: 'Are you ⟦S:0001⟧the Lord⟦/S:0001⟧?',
              confidence: 0.99,
              isHumanVerified: false,
              version: 1,
            },
          ],
          pagination: { page: 1, limit: 200, total: 1, totalPages: 1 },
          workspaceRevision: 1,
        }),
      });
    });

    await page.route(
      `**/api/v1/ai/jobs/${JOB_ID}/segments/${SEGMENT_ID_1}`,
      async (route) => {
        if (route.request().method() === 'PATCH') {
          patchCount++;
        }
        await route.fallback();
      },
    );

    await page.goto(`/studio/ai/jobs/${JOB_ID}`);
    await expect(page.getByTestId('novel-review-workspace')).toBeVisible();

    const textarea = page.getByTestId(`novel-segment-textarea-${SEGMENT_ID_1}`);
    // Corrupt anchor: delete opening tag ⟦S:0001⟧
    await textarea.fill('Are you the Lord⟦/S:0001⟧?');

    // Verify INVALID state badge and topology error banner
    await expect(page.getByTestId('novel-segment-state-badge')).toHaveText(
      'INVALID',
    );
    await expect(
      page.getByTestId('novel-segment-topology-error'),
    ).toBeVisible();

    // Verify Save button is DISABLED
    const saveBtn = page.getByTestId(`novel-segment-save-btn-${SEGMENT_ID_1}`);
    await expect(saveBtn).toBeDisabled();

    // Invariant: Zero PATCH requests made to server
    expect(patchCount).toBe(0);
  });

  test('Flow B2: Server Authoritative Rejection (400 ANCHOR_TOPOLOGY_VIOLATION) - Preserves draft, enters ERROR state, canonical untouched', async ({
    page,
  }) => {
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
            totalSteps: 5,
            completedSteps: 5,
            attemptCount: 1,
            maxAttempts: 3,
            createdAt: '2026-09-20T00:00:00.000Z',
            startedAt: '2026-09-20T00:01:00.000Z',
            heartbeatAt: '2026-09-20T00:05:00.000Z',
            completedAt: '2026-09-20T00:05:00.000Z',
            expiresAt: null,
            reviewRevision: 1,
            materializedRevision: 1,
            workspaceRevision: 1,
          },
          context: {
            story: {
              id: STORY_ID,
              title: 'Server Authority Test',
              slug: 'server-authority-test',
              mediaFormat: MediaFormat.NOVEL,
            },
            chapter: {
              id: CHAPTER_ID,
              chapterNumber: '1.00',
              title: 'Chương 1',
            },
            edition: {
              id: 'e1',
              editionName: 'Bản Dịch',
              language: 'vi',
              isDefault: true,
            },
            project: { id: 'p1', sourceLanguage: 'ja', targetLanguage: 'vi' },
            sourceVersion: { id: 'v1', versionNumber: 1 },
            targetVersion: null,
          },
          reviewSummary: {
            segmentCount: 1,
            verifiedCount: 0,
            pageCount: null,
            resultPageCount: null,
            blockCount: 1,
          },
          permissions: { canApply: false },
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
              id: SEGMENT_ID_1,
              jobId: JOB_ID,
              pageNumber: null,
              anchorBlockId: 'p-1',
              sortOrder: 1,
              bboxX: null,
              bboxY: null,
              bboxW: null,
              bboxH: null,
              rawText: 'Ngươi có phải ⟦S:0001⟧Chúa tể⟦/S:0001⟧ không?',
              translatedText: 'Are you ⟦S:0001⟧the Lord⟦/S:0001⟧?',
              confidence: 0.99,
              isHumanVerified: false,
              version: 1,
            },
          ],
          pagination: { page: 1, limit: 200, total: 1, totalPages: 1 },
          workspaceRevision: 1,
        }),
      });
    });

    // Mock server authoritative rejection: HTTP 400 ANCHOR_TOPOLOGY_VIOLATION
    await page.route(
      `**/api/v1/ai/jobs/${JOB_ID}/segments/${SEGMENT_ID_1}`,
      async (route) => {
        if (route.request().method() === 'PATCH') {
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'ANCHOR_TOPOLOGY_VIOLATION',
                message:
                  'Server Authoritative: Cấu trúc thẻ bảo vệ bị vi phạm quy tắc lồng nhau.',
              },
            }),
          });
          return;
        }
        await route.fallback();
      },
    );

    await page.goto(`/studio/ai/jobs/${JOB_ID}`);
    await expect(page.getByTestId('novel-review-workspace')).toBeVisible();

    const textarea = page.getByTestId(`novel-segment-textarea-${SEGMENT_ID_1}`);
    // Edit text with anchor tags (passes client validation)
    await textarea.fill('Bản dịch thử ⟦S:0001⟧Lord⟦/S:0001⟧');

    const saveBtn = page.getByTestId(`novel-segment-save-btn-${SEGMENT_ID_1}`);
    await expect(saveBtn).toBeEnabled();
    await saveBtn.click();

    // 1. Editor enters ERROR state
    await expect(page.getByTestId('novel-segment-state-badge')).toHaveText(
      'ERROR',
    );

    // 2. Error banner is shown with server message
    const errorBanner = page.getByTestId('novel-segment-error-banner');
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText('Server Authoritative');

    // 3. User draft is preserved in textarea (NOT wiped!)
    await expect(textarea).toHaveValue('Bản dịch thử ⟦S:0001⟧Lord⟦/S:0001⟧');

    // 4. Canonical version stays at v1 (NOT incremented)
    await expect(page.getByText('v1')).toBeVisible();
  });
});
