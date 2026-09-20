import { test, expect } from '@playwright/test';
import { TranslationJobStatus, MediaFormat } from '@omninovel/shared';

test.describe('Studio Dashboard & Realtime Job Monitor E2E (#145 Task 6)', () => {
  const mockStories = [
    {
      id: 'story-e2e-1',
      title: 'Solo Leveling E2E',
      slug: 'solo-leveling-e2e',
      mediaFormat: MediaFormat.COMIC,
      publicationFormat: 'WEBTOON',
      originCountry: 'KR',
      originalLanguage: 'ko',
      coverUrl: null,
      status: 'ONGOING',
      visibility: 'PUBLIC',
      summary: null,
      viewsCount: '15000',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
    },
  ];

  const mockJobs = [
    {
      id: 'job-e2e-review',
      projectId: 'proj-1',
      storyId: 'story-e2e-1',
      storyTitle: 'Solo Leveling E2E',
      storySlug: 'solo-leveling-e2e',
      mediaFormat: MediaFormat.COMIC,
      storyEditionId: 'edition-1',
      editionName: 'Bản Dịch Tiếng Việt',
      chapterId: 'chap-10',
      chapterNumber: '10.00',
      chapterTitle: 'Thức tỉnh Hạng E',
      sourceLanguage: 'ko',
      targetLanguage: 'vi',
      status: TranslationJobStatus.READY_FOR_REVIEW,
      progressPercentage: 100,
      provider: 'OPENAI',
      modelName: 'gpt-4o',
      createdAt: '2026-09-01T10:00:00Z',
      startedAt: '2026-09-01T10:01:00Z',
      completedAt: '2026-09-01T10:05:00Z',
      heartbeatAt: null,
    },
    {
      id: 'job-e2e-active',
      projectId: 'proj-1',
      storyId: 'story-e2e-1',
      storyTitle: 'Solo Leveling E2E',
      storySlug: 'solo-leveling-e2e',
      mediaFormat: MediaFormat.COMIC,
      storyEditionId: 'edition-1',
      editionName: 'Bản Dịch Tiếng Việt',
      chapterId: 'chap-11',
      chapterNumber: '11.00',
      chapterTitle: 'Hầm ngục kép',
      sourceLanguage: 'ko',
      targetLanguage: 'vi',
      status: TranslationJobStatus.TRANSLATING,
      progressPercentage: 45,
      provider: 'OPENAI',
      modelName: 'gpt-4o',
      createdAt: '2026-09-01T11:00:00Z',
      startedAt: '2026-09-01T11:01:00Z',
      completedAt: null,
      heartbeatAt: '2026-09-01T11:04:00Z',
    },
  ];

  test.beforeEach(async ({ page }) => {
    // Mock Auth
    await page.route('**/api/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ accessToken: 'mock_jwt_token' }),
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
        }),
      });
    });

    // Mock Managed Stories
    await page.route('**/api/v1/studio/stories*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: mockStories,
          pagination: { total: 1, page: 1, limit: 100, totalPages: 1 },
        }),
      });
    });

    // Mock Translation Jobs with filtering
    await page.route('**/api/v1/ai/jobs*', async (route) => {
      const url = new URL(route.request().url());
      const statusesParam = url.searchParams.get('statuses');
      const searchParam = url.searchParams.get('search');

      let filtered = [...mockJobs];

      if (statusesParam) {
        const statuses = statusesParam.split(',');
        filtered = filtered.filter((j) => statuses.includes(j.status));
      }

      if (searchParam) {
        const query = searchParam.toLowerCase();
        filtered = filtered.filter(
          (j) =>
            j.storyTitle.toLowerCase().includes(query) ||
            j.chapterNumber.includes(query) ||
            (j.chapterTitle && j.chapterTitle.toLowerCase().includes(query)),
        );
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: filtered,
          pagination: {
            total: filtered.length,
            page: 1,
            limit: 20,
            totalPages: 1,
          },
        }),
      });
    });
  });

  test('Flow 1: Dashboard loads, displays metrics, filters by REVIEW group, and provides deep-link CTA to Review Studio', async ({
    page,
  }) => {
    await page.goto('/studio');

    // 1. Verify header
    await expect(page.locator('h1')).toContainText('Bảng Điều Khiển Dịch Thuật');

    // 2. Verify metric cards
    await expect(page.getByTestId('metric-card-REVIEW')).toBeVisible();

    // 3. Filter by REVIEW
    await page.getByTestId('filter-pill-REVIEW').click();

    // 4. Verify filtered job is displayed
    await expect(
      page.getByRole('heading', { name: 'Solo Leveling E2E' }).first(),
    ).toBeVisible();
    await expect(page.getByText(/Chương 10\.00/)).toBeVisible();

    // 5. Verify CTA button leads to manga studio review
    const ctaButton = page.getByTestId('job-cta-button');
    await expect(ctaButton).toBeVisible();
    await expect(ctaButton).toHaveAttribute(
      'href',
      '/studio/manga?jobId=job-e2e-review',
    );
  });

  test('Flow 2: Search input filters translation jobs by chapter title', async ({
    page,
  }) => {
    await page.goto('/studio');

    // Search for chapter 11
    const searchInput = page.getByTestId('studio-search-input');
    await searchInput.fill('Hầm ngục kép');

    // Verify only job 11 appears
    await expect(page.getByText(/Chương 11\.00/)).toBeVisible();
    await expect(page.getByText(/45%/)).toBeVisible();
  });
});
