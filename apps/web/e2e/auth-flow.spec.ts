import { test, expect } from '@playwright/test';

test.describe('Web Foundation & Authentication E2E Flow', () => {
  test('Khởi tạo trang chủ OmniNovel với Dark theme, Logo và Navigation Shell', async ({ page }) => {
    await page.goto('/');

    // 1. Kiểm tra HTML data-theme mặc định là dark
    const htmlElement = page.locator('html');
    await expect(htmlElement).toHaveAttribute('data-theme', 'dark');

    // 2. Kiểm tra Header Logo và Search bar
    await expect(page.locator('header')).toBeVisible();
    await expect(page.getByText('OMNI')).toBeVisible();
    await expect(page.getByText('NOVEL')).toBeVisible();
    await expect(page.getByPlaceholder(/Tìm kiếm Manga, Light Novel/i)).toBeVisible();

    // 3. Kiểm tra Footer
    await expect(page.locator('footer')).toBeVisible();
    await expect(page.getByText('Anti-Leech Bot & Rate-Limiting Protected')).toBeVisible();
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
    // System resolves to light or dark depending on OS preference

    // Click 3: system -> dark
    await themeToggleBtn.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('Mở và tương tác AuthModal (Đăng Nhập & Đăng Ký tabs)', async ({ page }) => {
    await page.goto('/');

    const loginBtn = page.getByRole('button', { name: 'Đăng Nhập' });
    await loginBtn.click();

    // Modal xuất hiện
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();

    // Chuyển sang tab Đăng Ký
    const registerTabBtn = modal.getByRole('button', { name: 'Đăng Ký Tài Khoản' });
    await registerTabBtn.click();
    await expect(modal.getByPlaceholder('novel_master')).toBeVisible();

    // Đóng modal bằng nút Esc hoặc nút X
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible();
  });

  test('Kiểm tra trang 404 tùy biến', async ({ page }) => {
    await page.goto('/random-non-existent-page-404');
    await expect(page.getByText('404 - Không Tìm Thấy Trang')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Về Trang Chủ' })).toBeVisible();
  });
});
