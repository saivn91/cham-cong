import { createFileRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { ProtectedRoute } from '../../components/route-guard';

// Ranh giới xác thực chỉ dành cho quản trị viên (Admin) ở phân hệ bảng lương
export const Route = createFileRoute('/admin/payroll')({ component: AdminPayrollComponent });

function AdminPayrollComponent() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isRootPayroll = pathname === '/admin/payroll' || pathname === '/admin/payroll/';

  return (
    <ProtectedRoute allowedRoles={['admin']}>
        <div className="space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-gray-200 pb-4">
            <div>
              <h2 className="text-2xl font-bold text-gray-800">Quản lý Bảng lương</h2>
              <p className="text-sm text-gray-500">Thiết lập thông số tính lương, ngày nghỉ lễ và kỳ lương</p>
            </div>
            {/* Điều hướng nội bộ phân hệ Bảng lương */}
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/admin/payroll"
                activeOptions={{ exact: true }}
                className="px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-200 [&.active]:bg-blue-600 [&.active]:text-white"
              >
                Tổng quan
              </Link>
              <Link
                to="/admin/payroll/settings"
                className="px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-200 [&.active]:bg-blue-600 [&.active]:text-white"
              >
                Cấu hình ngày lễ
              </Link>
              <Link
                to="/admin/payroll/allowances"
                className="px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-200 [&.active]:bg-blue-600 [&.active]:text-white"
              >
                Kỳ lương & Phụ cấp
              </Link>
              <Link
                to="/admin/payroll/preview"
                className="px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-200 [&.active]:bg-blue-600 [&.active]:text-white"
              >
                Xem trước & Duyệt lương
              </Link>
              <Link
                to="/admin/payroll/view"
                className="px-3 py-2 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-200 [&.active]:bg-blue-600 [&.active]:text-white"
              >
                Bảng lương & Phiếu lương
              </Link>
            </div>
          </div>

          {isRootPayroll ? (
            <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
              <p className="text-sm text-gray-600">
                Tổng hợp công và tính lương nhân viên. Vui lòng chọn mục{' '}
                <Link to="/admin/payroll/settings" className="text-blue-600 font-medium hover:underline">
                  Cấu hình ngày lễ
                </Link>
                ,{' '}
                <Link to="/admin/payroll/allowances" className="text-blue-600 font-medium hover:underline">
                  Kỳ lương & Phụ cấp
                </Link>{' '}
                ,{' '}
                <Link to="/admin/payroll/preview" className="text-blue-600 font-medium hover:underline">
                  Xem trước & Duyệt lương
                </Link>{' '}
                hoặc{' '}
                <Link to="/admin/payroll/view" className="text-blue-600 font-medium hover:underline">
                  Bảng lương & Phiếu lương
                </Link>{' '}
                để thiết lập ngày nghỉ lễ, kỳ lương, các khoản phụ cấp và tra cứu bảng lương đã duyệt.
              </p>
            </div>
          ) : (
            <Outlet />
          )}
        </div>
    </ProtectedRoute>
  );
}
