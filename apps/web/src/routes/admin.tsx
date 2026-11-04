import { createFileRoute, Outlet } from '@tanstack/react-router';
import { ProtectedRoute } from '../components/route-guard';
import { AdminLayout } from '../layouts/AdminLayout';

// Ranh giới xác thực cho cấp quản lý và quản trị viên
export const Route = createFileRoute('/admin')({ component: AdminRouteComponent });

function AdminRouteComponent() {
  // Hiển thị nội dung các tuyến con bên trong bố cục quản trị
  return <ProtectedRoute allowedRoles={['manager', 'admin']}><AdminLayout><Outlet /></AdminLayout></ProtectedRoute>;
}
