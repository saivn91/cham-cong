import React, { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAuth } from '../lib/auth-context';

// Bố cục Quản trị: Giao diện desktop với sidebar cố định và header chung
export const AdminLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { role, signOut } = useAuth();
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const isAdmin = role === 'admin';

  // Đăng xuất và chỉ điều hướng về trang đăng nhập khi không có lỗi từ hệ thống xác thực
  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    setSignOutError(null);
    try {
      const { error } = await signOut();
      if (error === null) {
        await navigate({ to: '/login' });
      } else {
        setSignOutError('Không thể đăng xuất lúc này. Vui lòng thử lại.');
      }
    } catch {
      setSignOutError('Không thể đăng xuất lúc này. Vui lòng thử lại.');
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex">
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-gray-200 font-bold text-lg text-gray-800">Hệ thống Quản trị</div>
        <nav className="flex-1 p-4 space-y-1 flex flex-col">
          <Link to="/admin" className="px-4 py-2.5 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">Tổng quan</Link>
          <Link to="/admin/branches" className="px-4 py-2.5 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">Chi nhánh</Link>
          <Link to="/admin/employees" className="px-4 py-2.5 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">Nhân viên</Link>
          <Link to="/admin/devices" className="px-4 py-2.5 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">Thiết bị</Link>
          <Link to="/admin/shifts" className="px-4 py-2.5 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">Ca làm việc</Link>
          <Link to="/admin/punches" className="px-4 py-2.5 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">Dữ liệu chấm công</Link>
          <Link to="/admin/payroll" className="px-4 py-2.5 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">Bảng lương</Link>
          <Link to="/admin/payroll/settings" className="pl-8 pr-4 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">↳ Cấu hình ngày lễ</Link>
          <Link to="/admin/payroll/allowances" className="pl-8 pr-4 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">↳ Kỳ lương & Phụ cấp</Link>
          <Link to="/admin/payroll/preview" className="pl-8 pr-4 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">↳ Xem trước & Duyệt lương</Link>
          <Link to="/admin/payroll/view" className="pl-8 pr-4 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">↳ Bảng lương & Phiếu lương</Link>
          {isAdmin && (
            <Link to="/admin/reports" className="px-4 py-2.5 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">Báo cáo & Xuất Excel</Link>
          )}
          <Link to="/admin/audit" className="px-4 py-2.5 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 [&.active]:bg-blue-50 [&.active]:text-blue-600">Nhật ký hệ thống</Link>
        </nav>
      </aside>
      <div className="flex-1 flex flex-col min-w-0">
        <header className="min-h-16 bg-white border-b border-gray-200 flex flex-wrap items-center justify-between gap-3 px-4 sm:px-8 py-3">
          <h1 className="text-base font-medium text-gray-800">Trang quản lý</h1>
          <div className="flex flex-wrap items-center justify-end gap-3 ml-auto">
            {signOutError && (
              <p role="alert" className="text-xs sm:text-sm text-red-600">
                {signOutError}
              </p>
            )}
            <button
              type="button"
              onClick={handleSignOut}
              disabled={isSigningOut}
              className="px-3.5 py-2 rounded-md text-sm font-medium text-red-600 border border-red-200 hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
            >
              {isSigningOut ? 'Đang đăng xuất...' : 'Đăng xuất'}
            </button>
          </div>
        </header>
        <main className="flex-1 p-8 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
};

export default AdminLayout;
