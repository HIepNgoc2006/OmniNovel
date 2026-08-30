import { test, expect } from '@playwright/test';
import {
  MediaFormat,
  PublicationFormat,
  StoryStatus,
  StoryVisibility,
  ChapterVersionType,
} from '@omninovel/shared';

test.describe('Discovery, Catalog & Story Details E2E Flow (Phase 4B)', () => {
  const mockStories = [
    {
      id: 'story-comic-1',
      title: 'One Piece Đảo Hải Tặc',
      slug: 'one-piece-dao-hai-tac',
      mediaFormat: MediaFormat.COMIC,
      publicationFormat: PublicationFormat.MANGA,
      originCountry: 'JP',
      originalLanguage: 'ja',
      coverUrl: 'https://cdn.omninovel.com/covers/onepiece.jpg',
      status: StoryStatus.ONGOING,
      visibility: StoryVisibility.PUBLIC,
      summary: 'Hành trình của Monkey D. Luffy cùng băng Mũ Rơm chinh phục Đại Hải Trình để trở thành Vua Hải Tặc.',
      viewsCount: 2500000,
      followersCount: 1420,
      ratingAverage: 4.9,
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      genres: [
        { id: 1, name: 'Action', slug: 'action' },
        { id: 2, name: 'Adventure', slug: 'adventure' },
      ],
      editions: [
        {
          id: 'edition-1',
          storyId: 'story-comic-1',
          editionName: 'Bản Tiếng Việt Chuẩn',
          language: 'vi',
          isDefault: true,
          volumes: [
            { id: 'vol-1', storyEditionId: 'edition-1', volumeNumber: 1, title: 'Bình Minh Cuộc Phiêu Lưu' },
          ],
          chapters: [
            {
              id: 'chap-1',
              storyEditionId: 'edition-1',
              volumeId: 'vol-1',
              chapterNumber: 1,
              title: 'Romance Dawn',
              createdAt: '2026-08-01T00:00:00.000Z',
              viewsCount: 120000,
              activeVersion: {
                id: 'v-1',
                versionNumber: 1,
                versionType: ChapterVersionType.HUMAN_EDITED,
                isPublished: true,
                createdAt: '2026-08-01T00:00:00.000Z',
              },
            },
            {
              id: 'chap-1120',
              storyEditionId: 'edition-1',
              volumeId: 'vol-1',
              chapterNumber: 1120,
              title: 'Hòn Đảo Tương Lai',
              createdAt: '2026-08-28T00:00:00.000Z',
              viewsCount: 45000,
              activeVersion: {
                id: 'v-1120',
                versionNumber: 1,
                versionType: ChapterVersionType.AI_TRANSLATED,
                isPublished: true,
                createdAt: '2026-08-28T00:00:00.000Z',
              },
            },
          ],
        },
      ],
    },
    {
      id: 'story-novel-1',
      title: 'Mushoku Tensei - Thất Nghiệp Tái Sinh',
      slug: 'mushoku-tensei',
      mediaFormat: MediaFormat.NOVEL,
      publicationFormat: PublicationFormat.LIGHT_NOVEL,
      originCountry: 'JP',
      originalLanguage: 'ja',
      coverUrl: 'https://cdn.omninovel.com/covers/mushoku.jpg',
      status: StoryStatus.COMPLETED,
      visibility: StoryVisibility.PUBLIC,
      summary: 'Một NEET 34 tuổi chuyển sinh sang thế giới phép thuật và quyết định sống hết mình.',
      viewsCount: 1800000,
      followersCount: 980,
      ratingAverage: 4.8,
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
      genres: [
        { id: 3, name: 'Isekai', slug: 'isekai' },
        { id: 4, name: 'Fantasy', slug: 'fantasy' },
      ],
      editions: [
        {
          id: 'edition-2',
          storyId: 'story-novel-1',
          editionName: 'Bản Dịch AI Chuẩn',
          language: 'vi',
          isDefault: true,
          chapters: [
            {
              id: 'novel-chap-1',
              storyEditionId: 'edition-2',
              chapterNumber: 1,
              title: 'Tái Sinh Tại Thế Giới Khác',
              createdAt: '2026-08-01T00:00:00.000Z',
              viewsCount: 95000,
              activeVersion: {
                id: 'nv-1',
                versionNumber: 1,
                versionType: ChapterVersionType.AI_TRANSLATED,
                isPublished: true,
                createdAt: '2026-08-01T00:00:00.000Z',
              },
            },
          ],
        },
      ],
    },
  ];

  test.beforeEach(async ({ page }) => {
    // 1. Mock Featured Stories
    await page.route('**/api/v1/stories/featured', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          hotStories: mockStories,
          banners: mockStories,
        }),
      });
    });

    // 2. Mock Rankings
    await page.route('**/api/v1/stories/rankings', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          topComics: [mockStories[0]],
          topNovels: [mockStories[1]],
        }),
      });
    });

    // 3. Mock Story Detail By Slug
    await page.route('**/api/v1/stories/one-piece-dao-hai-tac', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockStories[0]),
      });
    });

    await page.route('**/api/v1/stories/mushoku-tensei', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockStories[1]),
      });
    });

    // 4. Mock Catalog /stories listing
    await page.route('**/api/v1/stories?**', async (route) => {
      const url = new URL(route.request().url());
      const format = url.searchParams.get('format');
      const search = url.searchParams.get('search') || url.searchParams.get('q');

      let filtered = [...mockStories];
      if (format) {
        filtered = filtered.filter((s) => s.mediaFormat === format);
      }
      if (search) {
        filtered = filtered.filter((s) =>
          s.title.toLowerCase().includes(search.toLowerCase())
        );
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: filtered,
          pagination: {
            page: 1,
            limit: 16,
            total: filtered.length,
            totalPages: 1,
          },
        }),
      });
    });

    // 5. Mock Auth / Gamification (Anonymous by default)
    await page.route('**/api/v1/auth/refresh', async (route) => {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'No refresh token' }),
      });
    });

    await page.route('**/api/v1/gamification/progression', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          userId: 'user-1',
          level: 5,
          totalExp: 450,
          currentLevelExp: 50,
          nextLevelExp: 100,
          omnicoinBalance: 150,
          streak: 4,
          rankTitle: 'Độc Giả Tinh Anh',
          lastCheckinDate: null,
          hasCheckedInToday: false,
        }),
      });
    });
  });

  test('Trang Chủ Discovery: Hero Slider, Danh Sách Mới Cập Nhật, Bảng Xếp Hạng & Điểm Danh', async ({ page }) => {
    await page.goto('/');

    // 1. Hero Carousel Slider
    await expect(page.getByText('HOT TRENDING')).toBeVisible();
    await expect(page.locator('h2').getByText(/One Piece/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Đọc Ngay' })).toBeVisible();

    // 2. Section Mới Cập Nhật & Story Cards
    await expect(page.getByText('Mới Cập Nhật')).toBeVisible();
    await expect(page.getByText('One Piece Đảo Hải Tặc')).toBeVisible();
    await expect(page.getByText('Mushoku Tensei - Thất Nghiệp Tái Sinh')).toBeVisible();

    // 3. Bảng Xếp Hạng
    const rankingsSection = page.locator('div').filter({ hasText: /Bảng Xếp Hạng/i });
    await expect(rankingsSection.first()).toBeVisible();
    await expect(page.getByText('🥇')).toBeVisible();

    // 4. Widget Điểm Danh Hàng Ngày
    await expect(page.getByText('Điểm Danh Hàng Ngày')).toBeVisible();
    await expect(page.getByRole('button', { name: /Điểm Danh|Đăng Nhập Để Nhận Thưởng/i })).toBeVisible();
  });

  test('Trang Tìm Kiếm & Bộ Lọc Nâng Cao: Filter Định Dạng, Thể Loại và Phân Trang', async ({ page }) => {
    await page.goto('/search');

    // 1. Tiêu đề và Search input
    await expect(page.getByText('Tìm Kiếm & Khám Phá Truyện')).toBeVisible();
    const searchInput = page.getByPlaceholder(/Nhập tên truyện, tác giả/i);
    await expect(searchInput).toBeVisible();

    // 2. Tìm kiếm với từ khóa "One Piece"
    await searchInput.fill('One Piece');
    await page.getByRole('button', { name: 'Tìm Kiếm' }).click();

    await expect(page.getByText('One Piece Đảo Hải Tặc')).toBeVisible();
    await expect(page.getByText('Tìm thấy 1 bộ truyện')).toBeVisible();

    // 3. Đặt lại bộ lọc
    const resetBtn = page.getByRole('button', { name: /Đặt lại bộ lọc/i });
    await expect(resetBtn).toBeVisible();
    await resetBtn.click();

    await expect(page.getByText('Mushoku Tensei - Thất Nghiệp Tái Sinh')).toBeVisible();
  });

  test('Trang Chi Tiết Bộ Truyện: Thông Tin, Danh Sách Chương và Bình Luận', async ({ page }) => {
    await page.goto('/stories/one-piece-dao-hai-tac');

    // 1. Tiêu đề bộ truyện & Badges
    const mainStoryTitle = page.locator('h1').getByText('One Piece Đảo Hải Tặc');
    await expect(mainStoryTitle).toBeVisible();
    await expect(page.getByText('Manga / Webtoon').first()).toBeVisible();
    await expect(page.getByText('Đang tiến hành').first()).toBeVisible();

    // 2. Action buttons
    await expect(page.getByRole('button', { name: /Đọc Từ Đầu/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Đọc Mới Nhất/i })).toBeVisible();

    // Toggle Theo Dõi
    const followBtn = page.getByRole('button', { name: /Theo Dõi/i });
    await expect(followBtn).toBeVisible();
    await followBtn.click();
    await expect(page.getByText('Đã Theo Dõi')).toBeVisible();

    // 3. Danh Sách Chương
    await expect(page.getByText('Danh Sách Chương')).toBeVisible();
    await expect(page.getByText('Chương 1: Romance Dawn')).toBeVisible();
    await expect(page.getByText('Chương 1120: Hòn Đảo Tương Lai')).toBeVisible();
    await expect(page.getByText('Biên Tập Viên')).toBeVisible();
    await expect(page.getByText('AI Dịch')).toBeVisible();

    // 4. Bình Luận & Đánh Giá
    await expect(page.getByText('Bình Luận & Đánh Giá')).toBeVisible();
    await expect(page.getByText('MangaMaster99')).toBeVisible();
    await expect(page.getByText('Lv.7')).toBeVisible();
  });
});
