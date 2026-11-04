import React, { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../lib/auth-context';
import { changeMyPin, updatePassword } from '../../lib/employee';
import { supabase } from '../../lib/supabase';

export const Route = createFileRoute('/app/profile')({
  component: EmployeeProfileComponent,
});

function EmployeeProfileComponent() {
  const { user, loading: authLoading, signOut } = useAuth();

  // Truy vấn mã nhân viên trực tiếp từ bảng public.employees theo user.id (không suy diễn từ email/metadata)
  const {
    data: employeeProfile,
    isLoading: employeeLoading,
    isError: employeeError,
  } = useQuery({
    queryKey: ['employee-profile', user?.id],
    enabled: !authLoading && !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select('employee_code')
        .eq('id', user!.id)
        .maybeSingle();

      if (error) {
        throw error;
      }

      return data;
    },
  });

  // Trạng thái biểu mẫu đổi mật khẩu
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);

  // Trạng thái biểu mẫu đổi mã PIN chấm công
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [pinLoading, setPinLoading] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinSuccess, setPinSuccess] = useState<string | null>(null);

  // Trạng thái đăng xuất
  const [logoutLoading, setLogoutLoading] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);

  // Xử lý kiểm tra và cập nhật mật khẩu đăng nhập (tối thiểu 8 ký tự và khớp xác nhận)
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSuccess(null);

    if (newPassword.length < 8) {
      setPasswordError('Mật khẩu mới phải có ít nhất 8 ký tự.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('Mật khẩu xác nhận không khớp.');
      return;
    }

    setPasswordLoading(true);
    try {
      await updatePassword(newPassword);
      setNewPassword('');
      setConfirmPassword('');
      setPasswordSuccess('Cập nhật mật khẩu thành công.');
    } catch (err) {
      setPasswordError(
        err instanceof Error ? err.message : 'Không thể cập nhật mật khẩu. Vui lòng thử lại.'
      );
    } finally {
      setPasswordLoading(false);
    }
  };

  // Xử lý kiểm tra định dạng PIN (4-6 chữ số) và gọi RPC đổi mã PIN
  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError(null);
    setPinSuccess(null);

    const pinRegex = /^\d{4,6}$/;
    if (!pinRegex.test(oldPin) || !pinRegex.test(newPin)) {
      setPinError('Mã PIN cũ và mã PIN mới phải gồm từ 4 đến 6 chữ số.');
      return;
    }

    setPinLoading(true);
    try {
      await changeMyPin(oldPin, newPin);
      setOldPin('');
      setNewPin('');
      setPinSuccess('Đổi mã PIN thành công.');
    } catch (err) {
      setPinError(
        err instanceof Error ? err.message : 'Không thể đổi mã PIN. Vui lòng thử lại.'
      );
    } finally {
      setPinLoading(false);
    }
  };

  // Xử lý đăng xuất tài khoản hiện tại
  const handleLogout = async () => {
    setLogoutError(null);
    setLogoutLoading(true);
    try {
      const { error } = await signOut();
      if (error) {
        throw error;
      }
    } catch (err) {
      setLogoutError(
        err instanceof Error ? err.message : 'Đăng xuất thất bại. Vui lòng thử lại.'
      );
    } finally {
      setLogoutLoading(false);
    }
  };

  if (authLoading) {
    return (
      <div className="rounded-lg border border-gray-100 bg-white p-6 text-center text-sm text-gray-500 shadow-sm">
        Đang tải thông tin hồ sơ...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-gray-800">Hồ sơ cá nhân</h1>

      {/* Thông tin tài khoản */}
      <div className="rounded-lg border border-gray-100 bg-white p-4 shadow-sm">
        <h2 className="text-base font-semibold text-gray-800">Thông tin tài khoản</h2>
        <p className="mt-1 text-sm text-gray-600">
          Mã nhân viên:{' '}
          {employeeLoading ? (
            <span className="text-gray-500">Đang tải...</span>
          ) : employeeError ? (
            <span className="text-red-600">Không thể tải mã nhân viên</span>
          ) : (
            <span className="font-medium text-gray-900">
              {employeeProfile?.employee_code?.trim() || 'Chưa cập nhật'}
            </span>
          )}
        </p>
      </div>

      {/* Biểu mẫu đổi mật khẩu */}
      <form
        onSubmit={handlePasswordSubmit}
        className="space-y-3 rounded-lg border border-gray-100 bg-white p-4 shadow-sm"
      >
        <h2 className="text-base font-semibold text-gray-800">Đổi mật khẩu</h2>

        {passwordError && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{passwordError}</div>
        )}
        {passwordSuccess && (
          <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">{passwordSuccess}</div>
        )}

        <div>
          <label htmlFor="new-password" className="block text-sm font-medium text-gray-700">
            Mật khẩu mới (tối thiểu 8 ký tự)
          </label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={passwordLoading}
            required
            minLength={8}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="confirm-password" className="block text-sm font-medium text-gray-700">
            Xác nhận mật khẩu mới
          </label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={passwordLoading}
            required
            minLength={8}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={passwordLoading}
          className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {passwordLoading ? 'Đang cập nhật...' : 'Cập nhật mật khẩu'}
        </button>
      </form>

      {/* Biểu mẫu đổi mã PIN */}
      <form
        onSubmit={handlePinSubmit}
        className="space-y-3 rounded-lg border border-gray-100 bg-white p-4 shadow-sm"
      >
        <h2 className="text-base font-semibold text-gray-800">Đổi mã PIN chấm công</h2>

        {pinError && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{pinError}</div>
        )}
        {pinSuccess && (
          <div className="rounded-md bg-green-50 p-3 text-sm text-green-700">{pinSuccess}</div>
        )}

        <div>
          <label htmlFor="old-pin" className="block text-sm font-medium text-gray-700">
            Mã PIN hiện tại (4 - 6 chữ số)
          </label>
          <input
            id="old-pin"
            type="password"
            inputMode="numeric"
            pattern="\d{4,6}"
            maxLength={6}
            value={oldPin}
            onChange={(e) => setOldPin(e.target.value)}
            disabled={pinLoading}
            required
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="new-pin" className="block text-sm font-medium text-gray-700">
            Mã PIN mới (4 - 6 chữ số)
          </label>
          <input
            id="new-pin"
            type="password"
            inputMode="numeric"
            pattern="\d{4,6}"
            maxLength={6}
            value={newPin}
            onChange={(e) => setNewPin(e.target.value)}
            disabled={pinLoading}
            required
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          disabled={pinLoading}
          className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {pinLoading ? 'Đang đổi mã PIN...' : 'Đổi mã PIN'}
        </button>
      </form>

      {/* Khu vực đăng xuất */}
      <div className="space-y-3 rounded-lg border border-gray-100 bg-white p-4 shadow-sm">
        {logoutError && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">{logoutError}</div>
        )}
        <button
          type="button"
          onClick={handleLogout}
          disabled={logoutLoading}
          className="w-full rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
        >
          {logoutLoading ? 'Đang đăng xuất...' : 'Đăng xuất'}
        </button>
      </div>
    </div>
  );
}
