import { test, expect } from '@playwright/test';
import {
  MediaFormat,
  PublicationFormat,
  StoryStatus,
  StoryVisibility,
  ChapterVersionType,
  MediaAssetType,
  ChapterDetailResponse,
} from '@omninovel/shared';

test.describe('Manga Reader Canvas E2E (Phase 4C)', () => {
  const mockChapterDetail: ChapterDetailResponse = {
    story: {
      id: 'story-manga-1',
      title: 'One Piece Đảo Hải Tặc',
      slug: 'one-piece-dao-hai-tac',
      mediaFormat: MediaFormat.COMIC,
      visibility: StoryVisibility.PUBLIC,
    },
    chapter: {
      id: 'chap-1',
      storyEditionId: 'edition-1',
      chapterNumber: 1,
      title: 'Romance Dawn',
      activeVersionId: 'v-1',
    },
    activeVersion: {
      id: 'v-1',
      versionNumber: 1,
      versionType: ChapterVersionType.HUMAN_EDITED,
      language: 'vi',
      isPublished: true,
      createdAt: '2026-08-01T00:00:00.000Z',
    },
    availableVersions: [
      {
        id: 'v-1',
        versionNumber: 1,
        versionType: ChapterVersionType.HUMAN_EDITED,
        language: 'vi',
        isPublished: true,
        createdAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'v-2',
        versionNumber: 2,
        versionType: ChapterVersionType.AI_TRANSLATED,
        language: 'vi',
        isPublished: true,
        createdAt: '2026-08-02T00:00:00.000Z',
      },
    ],
    mediaAssets: [
      {
        id: 'asset-page-1',
        sortOrder: 1,
        assetType: MediaAssetType.MANGA_PAGE,
        storageKey: 'pages/1.png',
        width: 800,
        height: 1200,
      },
      {
        id: 'asset-page-2',
        sortOrder: 2,
        assetType: MediaAssetType.MANGA_PAGE,
        storageKey: 'pages/2.png',
        width: 800,
        height: 1200,
      },
    ],
    navigation: {
      previous: null,
      next: {
        id: 'chap-2',
        chapterNumber: 2,
        title: 'Cậu Bé Mũ Rơm Luffy',
      },
    },
  };

  const mockStory = {
    id: 'story-manga-1',
    title: 'One Piece Đảo Hải Tặc',
    slug: 'one-piece-dao-hai-tac',
    mediaFormat: MediaFormat.COMIC,
    publicationFormat: PublicationFormat.MANGA,
    status: StoryStatus.ONGOING,
    visibility: StoryVisibility.PUBLIC,
    coverUrl: 'https://cdn.omninovel.com/covers/onepiece.jpg',
    viewsCount: 2500000,
    followersCount: 1420,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    editions: [
      {
        id: 'edition-1',
        storyId: 'story-manga-1',
        editionName: 'Bản Tiếng Việt Chuẩn',
        language: 'vi',
        isDefault: true,
        chapters: [
          {
            id: 'chap-1',
            storyEditionId: 'edition-1',
            chapterNumber: 1,
            title: 'Romance Dawn',
            createdAt: '2026-08-01T00:00:00.000Z',
          },
          {
            id: 'chap-2',
            storyEditionId: 'edition-1',
            chapterNumber: 2,
            title: 'Cậu Bé Mũ Rơm Luffy',
            createdAt: '2026-08-02T00:00:00.000Z',
          },
        ],
      },
    ],
  };

  test.beforeEach(async ({ page }) => {
    // Intercept Chapter Detail
    await page.route('**/api/v1/chapters/chap-1*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockChapterDetail),
      });
    });

    // Intercept Story Detail
    await page.route('**/api/v1/stories/one-piece-dao-hai-tac', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockStory),
      });
    });

    // Intercept Presigned Media URL
    await page.route('**/api/v1/storage/media-url/*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          assetId: 'asset-page-1',
          downloadUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          expiresInSeconds: 900,
        }),
      });
    });

    // Intercept Reading Progress Save
    await page.route('**/api/v1/library/reading-progress', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          storyId: 'story-manga-1',
          chapterId: 'chap-1',
          readingMode: 'WEBTOON',
          progressPercentage: 50,
          scrollPosition: 600,
          updatedAt: new Date().toISOString(),
        }),
      });
    });
  });

  test('phải hiển thị Manga HUD đầy đủ và không render App Shell Header/Footer', async ({ page }) => {
    await page.goto('/stories/one-piece-dao-hai-tac/read/chap-1');

    // Kiểm tra isolated reader canvas: không có main footer hay search bar của site layout
    await expect(page.locator('h1', { hasText: 'One Piece Đảo Hải Tặc' })).toBeVisible();
    await expect(page.locator('text=Chương 1 - Romance Dawn')).toBeVisible();
    await expect(page.locator('text=Webtoon')).toBeVisible();

    // App header của site layout không xuất hiện trong fullscreen reader
    await expect(page.locator('input[placeholder="Tìm kiếm manga, light novel, tác giả..."]')).not.toBeVisible();
  });

  test('phải chuyển đổi mượt mà giữa Webtoon và Paged RTL/LTR', async ({ page }) => {
    await page.goto('/stories/one-piece-dao-hai-tac/read/chap-1');

    // Chuyển sang Paged mode
    const modeBtn = page.locator('button', { hasText: 'Webtoon' });
    await modeBtn.click();

    await expect(page.locator('button', { hasText: 'Lật Trang' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'RTL' })).toBeVisible();

    // Chuyển RTL -> LTR
    const dirBtn = page.locator('button', { hasText: 'RTL' });
    await dirBtn.click();
    await expect(page.locator('button', { hasText: 'LTR' })).toBeVisible();
  });

  test('phải mở mục lục chương (Chapter Drawer) và lọc tìm kiếm chương', async ({ page }) => {
    await page.goto('/stories/one-piece-dao-hai-tac/read/chap-1');

    // Mở Drawer
    const drawerBtn = page.locator('button[title="Mục lục chương"]');
    await drawerBtn.click();

    await expect(page.locator('h2', { hasText: 'One Piece Đảo Hải Tặc' })).toBeVisible();
    await expect(page.locator('text=Danh sách 2 chương')).toBeVisible();

    // Tìm kiếm chương 2
    const searchInput = page.locator('input[placeholder="Tìm theo số chương hoặc tên..."]');
    await searchInput.fill('Luffy');

    await expect(page.getByRole('link', { name: /Chương 2/ })).toBeVisible();
  });

  test('phải mở Version Selector Modal và chọn bản dịch AI Translation Studio', async ({ page }) => {
    await page.goto('/stories/one-piece-dao-hai-tac/read/chap-1');

    // Mở modal đổi bản dịch
    const versionBtn = page.locator('button[title="Đổi bản dịch"]');
    await versionBtn.click();

    await expect(page.locator('h3', { hasText: 'Chọn Phiên Bản Bản Dịch' })).toBeVisible();
    await expect(page.locator('text=AI Studio Dịch')).toBeVisible();
    await expect(page.locator('text=Biên Tập Viên Trau Chuốt')).toBeVisible();
  });
});
