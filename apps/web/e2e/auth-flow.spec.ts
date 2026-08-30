import { test, expect } from '@playwright/test';

test.describe('Web Foundation & Authentication E2E Smoke Flow', () => {
  let isSessionActive = false;

  test.beforeEach(async ({ page }) => {
    isSessionActive = false;

    // Mock Core API Endpoints for deterministic browser testing
    await page.route('**/api/v1/stories**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [],
          meta: { total: 0, page: 1, limit: 8, totalPages: 1 },
        }),
      });
    });

    await page.route('**/api/v1/auth/login', async (route) => {
      isSessionActive = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'mock_bearer_jwt_token_2026',
          user: {
            id: 'user-uuid-1',
            username: 'novel_tester',
            email: 'tester@omninovel.com',
            role: 'USER',
            avatarUrl: null,
            createdAt: '2026-08-30T00:00:00.000Z',
          },
        }),
      });
    });

    await page.route('**/api/v1/auth/me', async (route) => {
      if (isSessionActive) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              id: 'user-uuid-1',
              username: 'novel_tester',
              email: 'tester@omninovel.com',
              role: 'USER',
              avatarUrl: null,
              createdAt: '2026-08-30T00:00:00.000Z',
            },
            permissions: ['READ_STORY', 'COMMENT'],
          }),
        });
      } else {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Unauthorized',
          }),
        });
      }
    });

    await page.route('**/api/v1/gamification/progression', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          userId: 'user-uuid-1',
          totalExp: 450,
          level: 5,
          rankTitle: 'Độc Giả Tinh Anh',
          currentLevelExp: 50,
          nextLevelExp: 100,
          omnicoinBalance: 150,
          streak: 4,
          lastCheckinDate: '2026-08-30',
        }),
      });
    });

    await page.route('**/api/v1/auth/refresh', async (route) => {
      if (isSessionActive) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            accessToken: 'mock_refreshed_jwt_token_2026',
          }),
        });
      } else {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            message: 'Không tìm thấy Refresh Token.',
          }),
        });
      }
    });

    await page.route('**/api/v1/auth/logout', async (route) => {
      isSessionActive = false;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'Đăng xuất thành công.',
        }),
      });
    });
  });

  test('Khởi tạo trang chủ OmniNovel với Dark theme, Logo và Navigation Shell', async ({ page }) => {
    await page.goto('/');

    // 1. Kiểm tra HTML data-theme mặc định là dark
    const htmlElement = page.locator('html');
    await expect(htmlElement).toHaveAttribute('data-theme', 'dark');

    // 2. Kiểm tra Header Logo và Search bar
    const header = page.locator('header');
    await expect(header).toBeVisible();
    await expect(header.getByText('OMNI')).toBeVisible();
    await expect(header.getByText('NOVEL')).toBeVisible();
    await expect(page.getByPlaceholder(/Tìm kiếm Manga, Light Novel/i)).toBeVisible();

    // 3. Kiểm tra Footer
    const footer = page.locator('footer');
    await expect(footer).toBeVisible();
    await expect(footer.getByText('Anti-Leech Bot & Rate-Limiting Protected')).toBeVisible();
  });

  test('Chuyển đổi Theme Dark / Light trên thanh điều hướng', async ({ page }) => {
    await page.goto('/');

    const themeToggleBtn = page.getByRole('button', { name: /Chuyển chủ đề/i });
    await expect(themeToggleBtn).toBeVisible();

    // Click 1: dark -> light
    await themeToggleBtn.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // Click 2: light -> system
    await themeToggleBtn.click();

    // Click 3: system -> dark
    await themeToggleBtn.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('Vertical Smoke: Login -> Progression UI -> Hard Reload F5 Restore Session -> Logout', async ({ page }) => {
    await page.goto('/');

    // 1. Mở Modal Đăng Nhập
    const loginBtn = page.getByRole('button', { name: 'Đăng Nhập' });
    await expect(loginBtn).toBeVisible();
    await loginBtn.click();

    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    // 2. Điền thông tin đăng nhập và Click nút Submit trong Form
    await modal.getByPlaceholder(/reader@omninovel.com hoặc novel_user/i).fill('novel_tester');
    await modal.getByPlaceholder('••••••••').fill('secure_password_123');
    await modal.locator('form').getByRole('button', { name: 'Đăng Nhập' }).click();

    // 3. Modal tự đóng và Header hiển thị thông tin User & Gamification
    await expect(modal).not.toBeVisible();
    const header = page.locator('header');
    await expect(header.getByRole('button', { name: 'novel_tester' })).toBeVisible();
    await expect(header.getByText('Lv.5')).toBeVisible();
    await expect(header.getByText('150')).toBeVisible(); // OmniCoins

    // 4. Truy cập trang Profile
    await page.goto('/profile');
    const mainContent = page.locator('main');
    await expect(mainContent.getByText('Độc Giả Tinh Anh')).toBeVisible();
    await expect(mainContent.getByText('450')).toBeVisible(); // Total EXP
    await expect(mainContent.getByText('4 ngày liên tiếp')).toBeVisible(); // Streak

    // 5. Hard Reload (F5) để kiểm tra Session Hydration qua refresh token & getMe
    await page.reload();
    await expect(page.locator('header').getByRole('button', { name: 'novel_tester' })).toBeVisible();
    await expect(page.locator('main').getByText('Độc Giả Tinh Anh')).toBeVisible();

    // 6. Mở User Dropdown và thực hiện Đăng Xuất
    await page.locator('header').getByRole('button', { name: 'novel_tester' }).click();
    await page.getByRole('button', { name: 'Đăng Xuất' }).click();

    // 7. Xác nhận đã trở về trạng thái Anonymous
    await expect(page.getByRole('button', { name: 'Đăng Nhập' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Đăng Ký' })).toBeVisible();
  });

  test('Kiểm tra trang 404 tùy biến', async ({ page }) => {
    await page.goto('/random-non-existent-page-404');
    await expect(page.getByText('404 - Không Tìm Thấy Trang')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Về Trang Chủ' })).toBeVisible();
  });
});
