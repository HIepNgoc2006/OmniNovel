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

test.describe('Light Novel Reader Canvas E2E (Phase 4C)', () => {
  const mockNovelChapterDetail: ChapterDetailResponse = {
    story: {
      id: 'story-novel-1',
      title: 'Toàn Chức Cao Thủ',
      slug: 'toan-chuc-cao-thu',
      mediaFormat: MediaFormat.NOVEL,
    },
    chapter: {
      id: 'chap-novel-1',
      storyEditionId: 'edition-novel-1',
      chapterNumber: 1,
      title: 'Diệp Tu Rời Khỏi Câu Lạc Bộ',
      activeVersionId: 'v-novel-1',
    },
    activeVersion: {
      id: 'v-novel-1',
      versionNumber: 1,
      versionType: ChapterVersionType.HUMAN_EDITED,
      language: 'vi',
      isPublished: true,
      createdAt: '2026-08-01T00:00:00.000Z',
    },
    availableVersions: [
      {
        id: 'v-novel-1',
        versionNumber: 1,
        versionType: ChapterVersionType.HUMAN_EDITED,
        language: 'vi',
        isPublished: true,
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ],
    mediaAssets: [
      {
        id: 'asset-novel-html-1',
        sortOrder: 1,
        assetType: MediaAssetType.NOVEL_HTML,
        storageKey: 'novels/chap1.html',
        width: null,
        height: null,
      },
    ],
    navigation: {
      previous: null,
      next: {
        id: 'chap-novel-2',
        chapterNumber: 2,
        title: 'Quán Net Hưng Hân Giữa Đêm Tuyết',
      },
    },
  };

  const sampleHtml = `
    <p>Tuyết rơi ngoài cửa sổ câu lạc bộ Gia Thế.</p>
    <p><ruby><rb>Diệp Tu</rb><rt>Ye Xiu</rt></ruby> đặt thẻ tài khoản <strong class="text-amber-500">Nhất Diệp Chi Thu</strong> xuống mặt bàn.</p>
    <p>Mười năm chinh chiến trong đấu trường <span data-footnote="Vinh Quang là tựa game thể thao điện tử MMORPG đỉnh cao">Vinh Quang</span> cuối cùng cũng khép lại một chương.</p>
  `;

  test.beforeEach(async ({ page }) => {
    // Intercept Chapter Detail
    await page.route('**/api/v1/chapters/chap-novel-1*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockNovelChapterDetail),
      });
    });

    // Intercept Presigned Media URL
    await page.route('**/api/v1/storage/media-url/*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          assetId: 'asset-novel-html-1',
          downloadUrl: 'https://cdn.omninovel.com/novels/chap1.html',
          expiresInSeconds: 900,
        }),
      });
    });

    // Intercept HTML file content fetch
    await page.route('https://cdn.omninovel.com/novels/chap1.html', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: sampleHtml,
      });
    });

    // Intercept Reading Progress Save
    await page.route('**/api/v1/library/reading-progress', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          storyId: 'story-novel-1',
          chapterId: 'chap-novel-1',
          readingMode: 'NOVEL',
          progressPercentage: 100,
          scrollPosition: 1200,
          updatedAt: new Date().toISOString(),
        }),
      });
    });
  });

  test('phải render Light Novel với Sepia theme và semantic Ruby tags', async ({ page }) => {
    await page.goto('/stories/toan-chuc-cao-thu/read/chap-novel-1');

    // Kiểm tra Sepia theme mặc định
    const themeWrapper = page.locator('[data-reader-theme="sepia"]');
    await expect(themeWrapper).toBeVisible();

    // Kiểm tra nội dung văn bản & Ruby tags
    await expect(page.locator('text=Tuyết rơi ngoài cửa sổ câu lạc bộ Gia Thế.')).toBeVisible();
    await expect(page.locator('ruby')).toBeVisible();
    await expect(page.locator('rt', { hasText: 'Ye Xiu' })).toBeVisible();
  });

  test('phải tùy chỉnh giao diện (Theme Dark & Cỡ Chữ) trong Settings Modal', async ({ page }) => {
    await page.goto('/stories/toan-chuc-cao-thu/read/chap-novel-1');

    // Mở Settings Modal
    const settingsBtn = page.locator('button[title="Tùy chỉnh giao diện đọc"]');
    await settingsBtn.click();

    await expect(page.locator('h3', { hasText: 'Tùy Chỉnh Giao Diện Đọc' })).toBeVisible();

    // Chuyển sang Dark Theme
    const darkBtn = page.locator('button', { hasText: 'Dark (Tối)' });
    await darkBtn.click();

    // Kiểm tra DOM đổi sang data-reader-theme="dark"
    await expect(page.locator('[data-reader-theme="dark"]')).toBeVisible();
  });

  test('phải hiển thị tooltip chú thích (Footnote) khi tương tác', async ({ page }) => {
    await page.goto('/stories/toan-chuc-cao-thu/read/chap-novel-1');

    // Chờ HTML tải xong
    const footnoteTarget = page.locator('span[data-footnote]');
    await expect(footnoteTarget).toBeVisible();

    // Click vào chú thích
    await footnoteTarget.click();

    // Tooltip xuất hiện
    await expect(page.locator('text=Vinh Quang là tựa game thể thao điện tử MMORPG đỉnh cao')).toBeVisible();
  });
});
