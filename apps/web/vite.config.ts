import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Kiểm tra đường dẫn module thuộc gói thư viện cụ thể trong node_modules (hỗ trợ cả pnpm/npm/yarn).
 */
function isPackageInNodeModules(normalizedId: string, pkgName: string): boolean {
  return (
    normalizedId.includes(`/node_modules/${pkgName}/`) ||
    normalizedId.endsWith(`/node_modules/${pkgName}`)
  );
}

export default defineConfig({
  plugins: [
    TanStackRouterVite({
      target: 'react',
      autoCodeSplitting: true,
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
    }),
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Loại trừ các chunk ExcelJS (~940KB) khỏi danh sách precache của Service Worker để giữ cơ chế chỉ tải khi người dùng xuất báo cáo
        globIgnores: ['**/exceljs*.js'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        /**
         * Chiến lược tách chunk thủ công bảo thủ (conservative manualChunks):
         * - Chỉ nhóm các thư viện lõi dùng chung toàn cục (React, Supabase, TanStack, UI/Validation)
         *   để giảm kích thước entry chunk ban đầu xuống dưới ngưỡng 500 KB và tối ưu bộ nhớ đệm trình duyệt.
         * - Tuyệt đối KHÔNG gộp chung tất cả `node_modules` vào một chunk duy nhất và KHÔNG ép
         *   `@fullcalendar/*` hay `exceljs` vào nhóm khởi tạo ban đầu, giúp bảo toàn cơ chế
         *   autoCodeSplitting theo route (cho FullCalendar) và nạp động `import('exceljs')` khi xuất báo cáo.
         */
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/');
          if (!normalizedId.includes('/node_modules/')) {
            return undefined;
          }

          // 1. Giữ nguyên ranh giới tải lười (lazy-load) cho ExcelJS và các phụ thuộc nội bộ của nó:
          // Không can thiệp để Rollup tự tách theo dynamic import('exceljs') trong export-workbook.ts.
          if (isPackageInNodeModules(normalizedId, 'exceljs')) {
            return undefined;
          }

          // 2. Giữ nguyên ranh giới tách code theo route cho FullCalendar và preact nội bộ của nó:
          // Chỉ nạp khi người dùng truy cập vào các route lịch ca làm việc (/app/shifts, v.v.).
          if (
            normalizedId.includes('/node_modules/@fullcalendar/') ||
            isPackageInNodeModules(normalizedId, 'preact')
          ) {
            return undefined;
          }

          // 3. Nhóm React Core (react, react-dom, scheduler) - nền tảng giao diện cốt lõi ít thay đổi.
          if (
            isPackageInNodeModules(normalizedId, 'react') ||
            isPackageInNodeModules(normalizedId, 'react-dom') ||
            isPackageInNodeModules(normalizedId, 'scheduler')
          ) {
            return 'vendor-react';
          }

          // 4. Nhóm Supabase SDK (@supabase/*) - xác thực, truy vấn CSDL PostgREST và kênh Realtime.
          if (normalizedId.includes('/node_modules/@supabase/')) {
            return 'vendor-supabase';
          }

          // 5. Nhóm TanStack (@tanstack/*) - quản lý định tuyến (Router) và trạng thái bất đồng bộ (React Query).
          if (normalizedId.includes('/node_modules/@tanstack/')) {
            return 'vendor-tanstack';
          }

          // 6. Nhóm tiện ích giao diện & kiểm tra dữ liệu dùng chung (Lucide Icons, Zod, Tailwind/Class helpers).
          if (
            isPackageInNodeModules(normalizedId, 'lucide-react') ||
            isPackageInNodeModules(normalizedId, 'zod') ||
            isPackageInNodeModules(normalizedId, 'clsx') ||
            isPackageInNodeModules(normalizedId, 'tailwind-merge') ||
            isPackageInNodeModules(normalizedId, 'class-variance-authority')
          ) {
            return 'vendor-ui-utils';
          }

          return undefined;
        },
      },
    },
  },
});