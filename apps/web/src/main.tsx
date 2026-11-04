import { registerSW } from 'virtual:pwa-register';
import { RouterProvider, createRouter } from '@tanstack/react-router';
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { AppProviders } from './lib/providers';
import { routeTree } from './routeTree.gen';

// Đăng ký PWA service worker an toàn, tránh lỗi đồng bộ chặn quá trình bootstrap React
try {
  registerSW({ immediate: true });
} catch (error) {
  console.error('Không thể đăng ký service worker:', error);
}

// Khởi tạo TanStack Router từ routeTree
const router = createRouter({ routeTree });

// Khai báo kiểu toàn cục cho router
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

interface RootErrorBoundaryState {
  hasError: boolean;
}

// Error Boundary cấp cao nhất hiển thị thông báo chung tiếng Việt thay vì màn hình trắng
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  RootErrorBoundaryState
> {
  state: RootErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RootErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error) {
    // Chỉ ghi log ở console trình duyệt để chẩn đoán, không hiển thị chi tiết nội bộ ra UI
    console.error('Lỗi runtime tại RootErrorBoundary:', error);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
          <h1 className="mb-2 text-xl font-bold text-red-600">
            Ứng dụng gặp sự cố khi khởi chạy
          </h1>
          <p className="mb-4 max-w-md text-sm text-gray-600">
            Đã xảy ra lỗi không mong muốn. Vui lòng tải lại trang hoặc thử lại sau.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Tải lại trang
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

// Mount trực tiếp vào #root nếu tồn tại, bỏ điều kiện kiểm tra innerHTML quá chặt
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Không tìm thấy phần tử gốc #root để khởi chạy ứng dụng.');
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <RootErrorBoundary>
      {/* Bọc toàn bộ router trong AppProviders để dùng chung QueryClient và AuthContext */}
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </RootErrorBoundary>
  </React.StrictMode>,
);
