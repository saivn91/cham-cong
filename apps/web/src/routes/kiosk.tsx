import { createFileRoute, Outlet } from '@tanstack/react-router';

// Layout route cho phân hệ Kiosk: chỉ render Outlet để '/kiosk/pair' truy cập công khai trước khi ghép nối
export const Route = createFileRoute('/kiosk')({
  component: KioskLayoutRoute,
});

function KioskLayoutRoute() {
  return <Outlet />;
}
