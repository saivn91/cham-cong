import { createFileRoute, Outlet } from '@tanstack/react-router';
import { ProtectedRoute } from '../components/route-guard';
import { EmployeeLayout } from '../layouts/EmployeeLayout';

// Ranh giới xác thực phân quyền nhân viên, cô lập luồng ứng dụng di động
export const Route = createFileRoute('/app')({ component: EmployeeRouteComponent });

function EmployeeRouteComponent() {
  // Hiển thị nội dung các tuyến con bên trong bố cục nhân viên
  return <ProtectedRoute allowedRoles={['employee']}><EmployeeLayout><Outlet /></EmployeeLayout></ProtectedRoute>;
}
