import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/admin/')({
  component: AdminDashboard,
})

function AdminDashboard() {
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold">Bảng điều khiển quản trị</h1>
      <p className="mt-2 text-gray-600">Khu vực dành cho quản trị viên hệ thống.</p>
    </div>
  )
}
