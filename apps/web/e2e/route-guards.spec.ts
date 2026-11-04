import { expect, test } from '@playwright/test';

// Bộ kiểm thử smoke xác minh ranh giới điều hướng (ProtectedRoute) khi chưa xác thực.
// Không sử dụng thông tin đăng nhập thật hay giả lập (mock) dữ liệu nghiệp vụ;
// độ phủ kiểm thử cơ sở dữ liệu và RPC thực tế nằm ở tầng kiểm thử tích hợp Supabase riêng.
test.describe('Kiểm thử route guard và màn hình đăng nhập', () => {
  test('chuyển hướng người dùng chưa đăng nhập từ /admin/reports về /login', async ({
    page,
  }) => {
    await page.goto('/admin/reports');
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
    await expect(
      page.getByRole('heading', { name: 'Đăng nhập hệ thống' })
    ).toBeVisible();
  });

  test('chuyển hướng người dùng chưa đăng nhập từ /kiosk về /login', async ({
    page,
  }) => {
    await page.goto('/kiosk');
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
    await expect(
      page.getByRole('heading', { name: 'Đăng nhập hệ thống' })
    ).toBeVisible();
  });

  test('hiển thị đầy đủ ô nhập email, mật khẩu và nút gửi trên biểu mẫu /login', async ({
    page,
  }) => {
    await page.goto('/login');

    const heading = page.getByRole('heading', { name: 'Đăng nhập hệ thống' });
    const emailInput = page.getByPlaceholder('ten@congty.com');
    const passwordInput = page.getByPlaceholder('••••••••');
    const submitButton = page.getByRole('button', { name: 'Đăng nhập' });

    await expect(heading).toBeVisible();
    await expect(emailInput).toBeVisible();
    await expect(emailInput).toHaveAttribute('type', 'email');
    await expect(passwordInput).toBeVisible();
    await expect(passwordInput).toHaveAttribute('type', 'password');
    await expect(submitButton).toBeVisible();
    await expect(submitButton).toBeEnabled();
  });
});