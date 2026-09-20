import { test, expect } from '@playwright/test';
import { MediaFormat } from '@omninovel/shared';

test.describe('Studio Translation Job Creation Workflow E2E (#146 Task 6)', () => {
  const mockStory = {
    id: 'story-e2e-1',
    title: 'Frieren Beyond Journeys End',
    slug: 'frieren-beyond-journeys-end',
    mediaFormat: MediaFormat.COMIC,
    publicationFormat: 'MANGA',
    originCountry: 'JP',
    originalLanguage: 'ja',
    coverUrl: null,
    status: 'ONGOING',
    visibility: 'PUBLIC',
    summary: 'A story of an elf mage.',
    viewsCount: '25000',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    editions: [
      {
        id: 'edition-jp-1',
        storyId: 'story-e2e-1',
        editionName: 'Bản Tiếng Nhật',
        language: 'ja',
        isDefault: true,
        chapters: [
          {
            id: 'chap-101',
            storyEditionId: 'edition-jp-1',
            chapterNumber: '1',
            title: 'Khởi đầu cuộc hành trình',
            activeVersionId: 'ver-101-raw',
          },
        ],
      },
    ],
  };

  const mockVersions = [
    {
      id: 'ver-101-raw',
      chapterId: 'chap-101',
      versionNumber: 1,
      versionType: 'RAW_ORIGINAL',
      language: 'ja',
      isPublished: true,
      sourceVersionId: null,
      createdAt: '2026-09-01T00:00:00Z',
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
          data: [
            {
              id: mockStory.id,
              title: mockStory.title,
              slug: mockStory.slug,
              mediaFormat: mockStory.mediaFormat,
              publicationFormat: mockStory.publicationFormat,
              originCountry: mockStory.originCountry,
              originalLanguage: mockStory.originalLanguage,
              coverUrl: null,
              status: mockStory.status,
              visibility: mockStory.visibility,
              summary: mockStory.summary,
              viewsCount: mockStory.viewsCount,
              createdAt: mockStory.createdAt,
              updatedAt: mockStory.updatedAt,
            },
          ],
          pagination: { total: 1, page: 1, limit: 100, totalPages: 1 },
        }),
      });
    });

    // Mock Story Detail by slug
    await page.route(`**/api/v1/stories/${mockStory.slug}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockStory),
      });
    });

    // Mock Chapter Versions for Studio
    await page.route(
      `**/api/v1/studio/chapters/chap-101/versions`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(mockVersions),
        });
      },
    );

    // Mock Destination Job Detail page API
    await page.route('**/api/v1/ai/jobs/job-created-e2e*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job: {
            id: 'job-created-e2e',
            status: 'VALIDATING',
            progressPercentage: 0,
          },
        }),
      });
    });
  });

  test('Flow 1: Happy path - Dashboard CTA navigation, hierarchy selection, and mock submission', async ({
    page,
  }) => {
    let capturedIdempotencyKey: string | null = null;
    let capturedBody: any = null;

    await page.route('**/api/v1/ai/jobs', async (route) => {
      if (route.request().method() === 'POST') {
        capturedIdempotencyKey = route
          .request()
          .headers()['idempotency-key'] || null;
        capturedBody = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            jobId: 'job-created-e2e',
            status: 'VALIDATING',
            isDuplicate: false,
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: [], pagination: { total: 0 } }),
        });
      }
    });

    // 1. Visit Studio Dashboard
    await page.goto('/studio');
    await expect(page.getByText('Bảng Điều Khiển Dịch Thuật')).toBeVisible();

    // 2. Click CTA "Tạo Bản Dịch Mới"
    const ctaBtn = page.getByTestId('create-job-cta-btn');
    await expect(ctaBtn).toBeVisible();
    await ctaBtn.click();

    // 3. Verify navigated to /studio/ai/jobs/new
    await page.waitForURL('**/studio/ai/jobs/new');
    await expect(page.getByRole('heading', { name: 'Tạo Bản Dịch Mới' })).toBeVisible();

    // 4. Select Story
    const storySelect = page.getByTestId('job-create-story-select');
    await expect(storySelect).toBeVisible();
    await storySelect.selectOption(mockStory.id);

    // 5. Select Edition
    const editionSelect = page.getByTestId('job-create-edition-select');
    await expect(editionSelect).toBeEnabled();
    await editionSelect.selectOption('edition-jp-1');

    // 6. Select Chapter
    const chapterSelect = page.getByTestId('job-create-chapter-select');
    await expect(chapterSelect).toBeEnabled();
    await chapterSelect.selectOption('chap-101');

    // 7. Select Version
    const versionSelect = page.getByTestId('job-create-version-select');
    await expect(versionSelect).toBeEnabled();
    await versionSelect.selectOption('ver-101-raw');

    // 8. Verify Source Language is filled and read-only
    await expect(page.getByLabel('Ngôn ngữ nguồn')).toHaveValue('JA');

    // 9. Submit with default MOCK provider
    const submitBtn = page.getByTestId('job-create-submit');
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // 10. Verify API was called with UUID-v4 Idempotency Key
    await page.waitForURL('**/studio/ai/jobs/job-created-e2e');
    expect(capturedIdempotencyKey).toBeTruthy();
    expect(capturedIdempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(capturedBody).toEqual({
      chapterVersionId: 'ver-101-raw',
      sourceLang: 'ja',
      targetLang: 'vi',
      provider: 'MOCK',
    });
    expect(capturedBody.externalConsent).toBeUndefined();
  });

  test('Flow 2: External provider consent gate enforces explicit consent checkbox', async ({
    page,
  }) => {
    let capturedBody: any = null;

    await page.route('**/api/v1/ai/jobs', async (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = JSON.parse(route.request().postData() || '{}');
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({
            jobId: 'job-created-e2e',
            status: 'VALIDATING',
            isDuplicate: false,
          }),
        });
      }
    });

    await page.goto('/studio/ai/jobs/new');

    // Select hierarchy
    await page.getByTestId('job-create-story-select').selectOption(mockStory.id);
    await page.getByTestId('job-create-edition-select').selectOption('edition-jp-1');
    await page.getByTestId('job-create-chapter-select').selectOption('chap-101');
    await page.getByTestId('job-create-version-select').selectOption('ver-101-raw');

    // Switch to External Provider (OPENAI)
    await page.getByTestId('job-create-provider-select').selectOption('OPENAI');

    // Verify disclosure is shown and submit button is disabled
    await expect(
      page.getByTestId('external-provider-consent-card'),
    ).toBeVisible();
    const submitBtn = page.getByTestId('job-create-submit');
    await expect(submitBtn).toBeDisabled();

    // Check explicit consent checkbox
    const consentCheckbox = page.getByLabel('Đồng ý gửi dữ liệu sang bên thứ ba');
    await consentCheckbox.check();

    // Now submit should be enabled
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    await page.waitForURL('**/studio/ai/jobs/job-created-e2e');
    expect(capturedBody.externalConsent).toBe(true);
    expect(capturedBody.provider).toBe('OPENAI');
  });

  test('Flow 3: Network/5xx ambiguity retains frozen Idempotency-Key across retry', async ({
    page,
  }) => {
    const keysReceived: string[] = [];
    let attempt = 0;

    await page.route('**/api/v1/ai/jobs', async (route) => {
      if (route.request().method() === 'POST') {
        const key = route.request().headers()['idempotency-key'] || '';
        keysReceived.push(key);
        attempt++;

        if (attempt === 1) {
          // Simulate 500 server error
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'INTERNAL_SERVER_ERROR',
                message: 'Server crashed after dispatching',
              },
            }),
          });
        } else {
          // Retry succeeds
          await route.fulfill({
            status: 202,
            contentType: 'application/json',
            body: JSON.stringify({
              jobId: 'job-created-e2e',
              status: 'VALIDATING',
              isDuplicate: true,
            }),
          });
        }
      }
    });

    await page.goto('/studio/ai/jobs/new');

    // Select hierarchy
    await page.getByTestId('job-create-story-select').selectOption(mockStory.id);
    await page.getByTestId('job-create-edition-select').selectOption('edition-jp-1');
    await page.getByTestId('job-create-chapter-select').selectOption('chap-101');
    await page.getByTestId('job-create-version-select').selectOption('ver-101-raw');

    // Submit first time
    const submitBtn = page.getByTestId('job-create-submit');
    await submitBtn.click();

    // Verify ambiguity alert banner is shown
    const ambiguityBanner = page.getByTestId('job-create-ambiguity-banner');
    await expect(ambiguityBanner).toBeVisible();
    await expect(
      page.getByText('Chưa xác định kết quả submission'),
    ).toBeVisible();

    // Click retry button with frozen key
    const retryBtn = page.getByRole('button', {
      name: /Thử lại với cùng Idempotency Key/i,
    });
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    // Navigation succeeds to job detail
    await page.waitForURL('**/studio/ai/jobs/job-created-e2e');

    // Crucial Invariant: Verify both attempts used the EXACT SAME Idempotency-Key
    expect(keysReceived).toHaveLength(2);
    expect(keysReceived[0]).toBeTruthy();
    expect(keysReceived[0]).toBe(keysReceived[1]);
  });
});
