import React from 'react';
import { Navigate } from '@tanstack/react-router';
import { useAuth, type UserRole } from '../lib/auth-context';

interface ProtectedRouteProps {
  allowedRoles: NonNullable<UserRole>[];
  children: React.ReactNode;
}

export function ProtectedRoute({ allowedRoles, children }: ProtectedRouteProps) {
  const { session, role, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <p className="text-sm text-gray-600">Đang tải...</p>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (!role || !allowedRoles.includes(role)) {
    // Chuyển hướng đúng trang đích của từng vai trò để tránh vòng lặp redirect vô hạn
    if (role === 'kiosk') {
      return <Navigate to="/kiosk" replace />;
    }
    if (role === 'employee') {
      return <Navigate to="/app" replace />;
    }
    if (role === 'manager' || role === 'admin') {
      return <Navigate to="/admin" replace />;
    }
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
