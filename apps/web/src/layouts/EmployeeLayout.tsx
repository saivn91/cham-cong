import React from 'react';
import { Link } from '@tanstack/react-router';

// Bố cục Nhân viên: Ưu tiên thiết bị di động với thanh điều hướng cố định ở dưới cùng
export const EmployeeLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col pb-16">
      <main className="flex-1 w-full max-w-md mx-auto p-4">{children}</main>
      <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 h-16 flex items-center justify-around z-50 max-w-md mx-auto">
        <Link to="/app" className="flex flex-col items-center justify-center w-full h-full text-xs font-medium text-gray-600 [&.active]:text-blue-600">Trang chủ</Link>
        <Link to="/app/shifts" className="flex flex-col items-center justify-center w-full h-full text-xs font-medium text-gray-600 [&.active]:text-blue-600">Ca làm</Link>
        <Link to="/app/timesheet" className="flex flex-col items-center justify-center w-full h-full text-xs font-medium text-gray-600 [&.active]:text-blue-600">Bảng công</Link>
        <Link to="/app/payroll" className="flex flex-col items-center justify-center w-full h-full text-xs font-medium text-gray-600 [&.active]:text-blue-600">Phiếu lương</Link>
        <Link to="/app/profile" className="flex flex-col items-center justify-center w-full h-full text-xs font-medium text-gray-600 [&.active]:text-blue-600">Hồ sơ</Link>
      </nav>
    </div>
  );
};

export default EmployeeLayout;
