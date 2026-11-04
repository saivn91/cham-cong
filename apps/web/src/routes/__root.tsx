import { Outlet, createRootRoute } from '@tanstack/react-router';

// Root layout bao bọc các route con qua Outlet và cung cấp fallback chung khi route gặp lỗi
export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen">
      <Outlet />
    </div>
  ),
  errorComponent: ({ error }) => {
    // Ghi log lỗi vào console để hỗ trợ gỡ lỗi mà không lộ thông tin nội bộ lên giao diện
    console.error('Lỗi hiển thị tại route:', error);
    return (
      <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
        <h1 className="mb-2 text-xl font-bold text-red-600">
          Đã xảy ra lỗi khi hiển thị trang
        </h1>
        <p className="mb-4 max-w-md text-sm text-gray-600">
          Hệ thống gặp sự cố ngoài ý muốn. Vui lòng tải lại trang hoặc thử lại sau.
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
  },
});
