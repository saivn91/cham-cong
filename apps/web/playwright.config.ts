import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const configDir = path.dirname(fileURLToPath(import.meta.url));
const requireFromWeb = createRequire(import.meta.url);
const vitePackageJsonPath = requireFromWeb.resolve('vite/package.json');
const viteCliPath = path.resolve(
  path.dirname(vitePackageJsonPath),
  'bin',
  'vite.js'
);

// Khởi chạy trực tiếp CLI của Vite bằng binary Node hiện tại để tránh lỗi spawn .cmd/npm/pnpm trên Windows
// và đảm bảo hoạt động ổn định dù chạy Playwright từ thư mục gốc workspace hay từ apps/web.
const webServerCommand = `"${process.execPath}" "${viteCliPath}" --host 127.0.0.1 --port 4173 --strictPort`;

// Cấu hình Playwright cho bộ kiểm thử smoke E2E giao diện và route guard cục bộ.
// Biến môi trường placeholder an toàn vì Supabase client chỉ đọc phiên cục bộ (null) mà không gọi DB thật.
// Các kiểm thử luồng nghiệp vụ có kết nối cơ sở dữ liệu thật (RPC, RLS) được tách biệt ở bộ test tích hợp backend bên ngoài.
export default defineConfig({
  testDir: path.join(configDir, 'e2e'),
  timeout: 15_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: webServerCommand,
    cwd: configDir,
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      VITE_SUPABASE_URL:
        process.env.VITE_SUPABASE_URL || 'http://127.0.0.1:54321',
      VITE_SUPABASE_ANON_KEY:
        process.env.VITE_SUPABASE_ANON_KEY ||
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.placeholder.signature',
    },
  },
});