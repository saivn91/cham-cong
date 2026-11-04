import React, { useState } from 'react';
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { EMPLOYEE_CODE_REGEX, employeeCodeToEmail } from '@timekeeping/shared/auth';
import { useAuth } from '../lib/auth-context';

// Route đăng nhập công khai, tách biệt khỏi các luồng đã xác thực
export const Route = createFileRoute('/login')({
  component: LoginPage,
});

function LoginPage() {
  const { session, role, loading, signIn } = useAuth();
  // Mặc định đăng nhập bằng mã nhân viên ('code'), giữ chế độ 'email' làm lựa chọn phụ cho Admin/Kiosk
  const [loginMode, setLoginMode] = useState<'code' | 'email'>('code');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return <div className="flex h-screen w-full items-center justify-center bg-gray-50"><p className="text-sm text-gray-600">Đang tải...</p></div>;
  }

  // Chuyển hướng tự động nếu người dùng đã có phiên đăng nhập và vai trò hợp lệ
  if (session && role) {
    if (role === 'kiosk') return <Navigate to="/kiosk" replace />;
    if (role === 'employee') return <Navigate to="/app" replace />;
    if (role === 'manager' || role === 'admin') return <Navigate to="/admin" replace />;
  }

  // Khi đổi chế độ đăng nhập, xóa toàn bộ lỗi, định danh và mật khẩu để tránh nhầm lẫn trạng thái
  const handleToggleMode = () => {
    setLoginMode((prev) => (prev === 'code' ? 'email' : 'code'));
    setIdentifier('');
    setPassword('');
    setErrorMsg(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const trimmedIdentifier = identifier.trim();
    if (!trimmedIdentifier || !password) {
      setErrorMsg(
        loginMode === 'code'
          ? 'Vui lòng nhập đầy đủ mã nhân viên và mật khẩu.'
          : 'Vui lòng nhập đầy đủ email và mật khẩu.',
      );
      return;
    }

    let loginEmail = trimmedIdentifier;
    if (loginMode === 'code') {
      // Xác thực mã nhân viên (4-6 chữ số, không bắt đầu bằng 0) và ánh xạ ngầm sang email nội bộ
      if (!EMPLOYEE_CODE_REGEX.test(trimmedIdentifier)) {
        setErrorMsg('Mã nhân viên không hợp lệ (gồm 4-6 chữ số, không bắt đầu bằng số 0).');
        return;
      }
      loginEmail = employeeCodeToEmail(trimmedIdentifier);
    } else {
      loginEmail = trimmedIdentifier.toLowerCase();
    }

    setSubmitting(true);
    try {
      const { error } = await signIn(loginEmail, password);
      // Trả thông báo lỗi chung để không lộ việc tài khoản có tồn tại trên hệ thống hay không
      if (error) setErrorMsg('Đăng nhập thất bại. Vui lòng kiểm tra lại thông tin.');
    } catch {
      setErrorMsg('Đăng nhập thất bại. Vui lòng kiểm tra lại thông tin.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100 p-4">
      <div className="w-full max-w-md rounded-lg bg-white p-8 shadow-md">
        <h1 className="mb-6 text-center text-2xl font-bold text-gray-800">Đăng nhập hệ thống</h1>
        {session && !role && <div className="mb-4 rounded bg-yellow-50 p-3 text-sm text-yellow-700">Tài khoản của bạn chưa được cấp quyền truy cập.</div>}
        {errorMsg && <div className="mb-4 rounded bg-red-50 p-3 text-sm text-red-600">{errorMsg}</div>}
        <form onSubmit={handleSubmit} className="space-y-4">
          {loginMode === 'code' ? (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Mã nhân viên</label>
              <input
                type="text"
                inputMode="numeric"
                pattern="[1-9][0-9]{3,5}"
                maxLength={6}
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="Nhập mã số (4-6 chữ số)"
                autoComplete="username"
                required
              />
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Email</label>
              <input
                type="email"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="ten@congty.com"
                autoComplete="email"
                required
              />
            </div>
          )}
          <div><label className="mb-1 block text-sm font-medium text-gray-700">Mật khẩu</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none" placeholder="••••••••" required /></div>
          <button type="submit" disabled={submitting} className="w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">{submitting ? 'Đang xử lý...' : 'Đăng nhập'}</button>
        </form>
        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={handleToggleMode}
            disabled={submitting}
            className="text-xs text-gray-500 underline hover:text-blue-600 focus:outline-none disabled:opacity-50"
          >
            {loginMode === 'code' ? 'Đăng nhập bằng email' : 'Đăng nhập bằng mã nhân viên'}
          </button>
        </div>
      </div>
    </div>
  );
}
