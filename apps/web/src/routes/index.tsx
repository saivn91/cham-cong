import { createFileRoute, Link, Navigate } from '@tanstack/react-router';
import { useAuth } from '../lib/auth-context';

// Route trang chủ tạm thời tại '/'
export const Route = createFileRoute('/')({
  component: IndexComponent,
});

function IndexComponent() {
  const { user, role, loading, authError } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <p className="text-gray-600">Đang tải...</p>
      </div>
    );
  }

  // Điều hướng tự động theo vai trò (role-based entry routing)
  if (user && role) {
    if (role === 'kiosk') return <Navigate to="/kiosk" replace />;
    if (role === 'admin' || role === 'manager') return <Navigate to="/admin" replace />;
    if (role === 'employee') return <Navigate to="/app" replace />;
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-4 text-center">
      <h1 className="mb-4 text-3xl font-bold">Hệ thống Chấm Công</h1>
      {authError && (
        <div className="mb-4 max-w-md rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p className="mb-2">{authError}</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-700"
          >
            Tải lại trang
          </button>
        </div>
      )}
      {user ? (
        <p className="text-gray-600">Tài khoản chưa được phân quyền. Vui lòng liên hệ quản trị viên.</p>
      ) : (
        <>
          <p className="mb-6 text-gray-600">Vui lòng đăng nhập để tiếp tục</p>
          <Link to="/login" className="rounded bg-blue-600 px-6 py-2 font-medium text-white hover:bg-blue-700">Đăng nhập</Link>
        </>
      )}
    </div>
  );
}
