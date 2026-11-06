import React, { useState, useEffect } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../lib/auth-context';
import { apiFetch } from '../../lib/api';

// Định nghĩa route chính xác theo cấu trúc TanStack Router
export const Route = createFileRoute('/admin/devices')({
  component: AdminDevicesPage,
});

interface Branch {
  id: string;
  code: string;
  name: string;
}

interface DeviceRow {
  id: string;
  name: string;
  branch_id: string;
  auth_user_id: string | null;
  revoked_at: string | null;
  created_at: string;
  branches?: {
    id: string;
    code: string;
    name: string;
  } | null;
}

interface CreateDevicePayload {
  branchId: string;
  name: string;
}

interface CreateDeviceResponse {
  ok: boolean;
  deviceId: string;
  pairingCode: string;
  expiresAt: string;
}

function AdminDevicesPage() {
  const { user, role } = useAuth();
  const queryClient = useQueryClient();

  // BẢO MẬT: Chỉ role 'admin' mới có quyền tạo mới hoặc thu hồi (revoke) thiết bị.
  // Role 'manager' chỉ được phép xem danh sách thiết bị thuộc phạm vi quản lý (RLS).
  const isAdmin = role === 'admin';

  // State cho form tạo thiết bị mới
  const [branchId, setBranchId] = useState('');
  const [name, setName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // State hiển thị mã ghép nối (Pairing Code) dùng 1 lần sau khi tạo thành công
  const [pairingInfo, setPairingInfo] = useState<{
    deviceId: string;
    deviceName: string;
    pairingCode: string;
    expiresAt: string;
  } | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number>(0);

  // BẢO MẬT: Query key bắt buộc phải gắn kèm user?.id và role để cô lập bộ nhớ đệm (cache)
  // giữa các phiên đăng nhập khác nhau, tránh rò rỉ dữ liệu thiết bị giữa các tài khoản.
  const devicesQuery = useQuery({
    queryKey: ['admin-devices', user?.id, role],
    enabled: Boolean(user?.id),
    queryFn: async (): Promise<DeviceRow[]> => {
      const { data, error } = await supabase
        .from('devices')
        .select('id, name, branch_id, auth_user_id, revoked_at, created_at, branches(id, code, name)')
        .order('created_at', { ascending: false });

      if (error) {
        throw new Error(error.message);
      }
      return (data as unknown as DeviceRow[]) ?? [];
    },
  });

  // Truy vấn danh sách chi nhánh cho dropdown chọn chi nhánh
  const branchesQuery = useQuery({
    queryKey: ['admin-branches-dropdown', user?.id, role],
    enabled: Boolean(user?.id),
    queryFn: async (): Promise<Branch[]> => {
      const { data, error } = await supabase
        .from('branches')
        .select('id, code, name')
        .order('name', { ascending: true });

      if (error) {
        throw new Error(error.message);
      }
      return data ?? [];
    },
  });

  // Quản lý bộ đếm ngược thời gian hiệu lực của mã ghép nối và dọn dẹp timer khi unmount
  useEffect(() => {
    if (!pairingInfo) {
      setSecondsLeft(0);
      return;
    }

    const calculateRemaining = () => {
      const expireTime = new Date(pairingInfo.expiresAt).getTime();
      const now = Date.now();
      return Math.max(0, Math.floor((expireTime - now) / 1000));
    };

    setSecondsLeft(calculateRemaining());

    const timerId = window.setInterval(() => {
      const remaining = calculateRemaining();
      setSecondsLeft(remaining);
      if (remaining <= 0) {
        window.clearInterval(timerId);
      }
    }, 1000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [pairingInfo]);

  // Mutation tạo thiết bị mới (chỉ dành cho Admin)
  const createDeviceMutation = useMutation({
    mutationFn: async (payload: CreateDevicePayload) => {
      // BẢO MẬT: Gọi qua backend API để khởi tạo Auth user cho thiết bị và sinh mã ghép nối tạm thời
      return await apiFetch<CreateDeviceResponse>('/api/devices', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (data, variables) => {
  
      setName('');
      setFormError(null);

      setPairingInfo({
        deviceId: data.deviceId,
        deviceName: variables.name,
        pairingCode: data.pairingCode,
        expiresAt: data.expiresAt,
      });

      queryClient.invalidateQueries({
        queryKey: ['admin-devices', user?.id, role],
      });
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : 'Không thể tạo thiết bị mới.';
      setFormError(message);
    },
  });
  
  // Cấp lại mã ghép nối khi mã cũ hết hạn hoặc cần ghép lại(chỉ Admin)
  const regenerateCodeMutation = ({
    mutationFn: async (device: DeviceRow) => {
      return await apiFetch<CreateDeviceResponse>('/api/devices/${device.id}/pairing-code',{method: 'POST',});
    },
    onSuccess: (data, device) => {
      setPairingInfo({
        deviceId: data.deviceId,
        deviceName: device.name,
        pairingCode: data.pairingCode,
        expiresAt: data.expiresAt,
      });
    },
  });

  // Mutation thu hồi quyền truy cập của thiết bị (chỉ dành cho Admin)
  const revokeDeviceMutation = useMutation({
    mutationFn: async (deviceId: string) => {
      return await apiFetch<{ ok: boolean }>(`/api/devices/${deviceId}/revoke`, {
        method: 'POST',
      });
    },
    onSuccess: (_data, revokedDeviceId) => {
      if (pairingInfo?.deviceId === revokedDeviceId) {
        setPairingInfo(null);
      }
      queryClient.invalidateQueries({
        queryKey: ['admin-devices', user?.id, role],
      });
    },
  });

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;

    setFormError(null);
    const trimmedName = name.trim();

    if (!branchId || !trimmedName ) {
      setFormError('Vui lòng chọn  chi nhánh và nhập tên thiết bị.');
      return;
    }

    createDeviceMutation.mutate({
      branchId,
      name: trimmedName,
    });
  };

  const handleRegenerateClick = (device: DeviceRow) => {
    if (!isAdmin || device.revoked_at) return;
    
    if (
      device.auth_user_id && !window.confirm(
        `Thiết bị "${device.name}" đang được ghép nối. \nKhi mã mới được nhập trên iPad khác, iPad hiện tại sec bị ngắt kết nối. Tiếp tục?`
        )
    ) {
      return;
    }
    regenerateCodeMutation.mutate(device);
  };

  const handleRevokeClick = (device: DeviceRow) => {
    if (!isAdmin || device.revoked_at) return;

    const confirmed = window.confirm(
      `Bạn có chắc chắn muốn thu hồi thiết bị "${device.name}" không?\nThiết bị này sẽ ngay lập tức mất quyền truy cập hệ thống.`
    );

    if (confirmed) {
      revokeDeviceMutation.mutate(device.id);
    }
  };

  const formatCountdown = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  return (
    <div className="space-y-8 p-6">
      <div className="flex flex-col justify-between gap-2 border-b pb-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Quản lý thiết bị</h1>
          <p className="text-sm text-gray-600">
            Danh sách các thiết bị đầu cuối được cấp phép kết nối vào hệ thống chi nhánh.
          </p>
        </div>
        {!isAdmin && (
          <span className="inline-flex items-center rounded-md bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/20">
            Chế độ xem (Quản lý không có quyền thêm hoặc thu hồi thiết bị)
          </span>
        )}
      </div>

      {/* Khu vực hiển thị Mã ghép nối một lần (One-time Pairing Code) */}
      {isAdmin && pairingInfo && (
        <div
          role="alert"
          className="rounded-lg border-2 border-indigo-600 bg-indigo-50 p-5 shadow-sm"
        >
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold text-indigo-950">
                Mã ghép nối một lần cho thiết bị: {pairingInfo.deviceName}
              </h2>
              <p className="mt-1 text-sm text-indigo-800">
                 Trên iPad, mở trang <span className="font-mono">/kiosk/pair</span> và  nhập mã này. Mã chỉ hiển thị một lần duy nhất.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setPairingInfo(null)}
              className="rounded-md px-2.5 py-1 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
            >
              Đóng
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-6">
            <div className="rounded-md bg-white px-5 py-3 font-mono text-3xl font-bold tracking-widest text-indigo-900 shadow-inner ring-1 ring-indigo-200">
              {pairingInfo.pairingCode}
            </div>

            <div className="text-sm">
              {secondsLeft > 0 ? (
                <div className="font-medium text-indigo-900">
                  Thời gian hiệu lực còn lại:{' '}
                  <span className="font-mono text-base font-bold text-red-600">
                    {formatCountdown(secondsLeft)}
                  </span>
                </div>
              ) : (
                <div className="font-semibold text-red-600">
                  Mã ghép nối đã hết hạn.
                </div>
              )}
              <div className="text-xs text-indigo-700">
                Hết hạn lúc: {new Date(pairingInfo.expiresAt).toLocaleString('vi-VN')}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Biểu mẫu đăng ký thiết bị mới - Chỉ hiển thị cho Admin */}
      {isAdmin && (
        <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">Thêm thiết bị mới</h2>
          <p className="mt-1 text-sm text-gray-500">
            Tạo thiết bị và nhận mã ghép nối dùng một lần.
          </p>

          {formError && (
            <div className="mt-4 rounded-md bg-red-50 p-3 text-sm text-red-700 ring-1 ring-inset ring-red-600/20">
              Lỗi: {formError}
            </div>
          )}

          <form onSubmit={handleCreateSubmit} className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="device-branch" className="block text-sm font-medium text-gray-700">
                Chi nhánh
              </label>
              <select
                id="device-branch"
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                disabled={branchesQuery.isLoading || createDeviceMutation.isPending}
                required
                className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value="">-- Chọn chi nhánh --</option>
                {branchesQuery.data?.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.code} - {branch.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="device-name" className="block text-sm font-medium text-gray-700">
                Tên thiết bị
              </label>
              <input
                id="device-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={createDeviceMutation.isPending}
                placeholder="VD: Máy POS Quầy 01"
                required
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div className="sm:col-span-2 flex justify-end pt-2">
              <button
                type="submit"
                disabled={createDeviceMutation.isPending}
                className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {createDeviceMutation.isPending ? 'Đang tạo thiết bị...' : 'Tạo thiết bị & Lấy mã ghép nối'}
              </button>
            </div>
          </form>
        </section>    
      )}

      {/* Bảng danh sách thiết bị */}
      <section className="rounded-lg border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Danh sách thiết bị trong hệ thống</h2>
        </div>

        {revokeDeviceMutation.isError && (
          <div className="m-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            Lỗi thu hồi thiết bị:{' '}
            {revokeDeviceMutation.error instanceof Error
              ? revokeDeviceMutation.error.message
              : 'Đã xảy ra lỗi không xác định.'}
          </div>
        )}
        
        {regenerateCodeMutation.isError && (
          <div className="m-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
            Lỗi tạo mã ghép nối:{' '}
          {regenerateCodeMutation.error instanceof Error ? regenerateCodeMutation.error.message : 'Đã xảy ra lỗi không xác định.'}
          </div>
        )}

        {devicesQuery.isLoading ? (
          <div className="p-8 text-center text-sm text-gray-500">
            Đang tải danh sách thiết bị...
          </div>
        ) : devicesQuery.isError ? (
          <div className="p-8 text-center text-sm text-red-600">
            Không thể tải danh sách thiết bị:{' '}
            {devicesQuery.error instanceof Error ? devicesQuery.error.message : 'Lỗi kết nối cơ sở dữ liệu.'}
          </div>
        ) : !devicesQuery.data || devicesQuery.data.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            Chưa có thiết bị nào được đăng ký.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
              <thead className="bg-gray-50 text-xs font-semibold uppercase text-gray-600">
                <tr>
                  <th className="px-6 py-3">Tên thiết bị</th>
                  <th className="px-6 py-3">Chi nhánh</th>
                  <th className="px-6 py-3">Auth User ID</th>
                  <th className="px-6 py-3">Ngày tạo</th>
                  <th className="px-6 py-3">Trạng thái</th>
                  {isAdmin && <th className="px-6 py-3 text-right">Thao tác</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {devicesQuery.data.map((device) => {
                  const isRevoked = Boolean(device.revoked_at);
                  const branchObj = Array.isArray(device.branches)
                    ? device.branches[0]
                    : device.branches;

                  const branchDisplay = branchObj
                    ? `${branchObj.code} - ${branchObj.name}`
                    : branchesQuery.data?.find((b) => b.id === device.branch_id)?.name ?? device.branch_id;

                  return (
                    <tr key={device.id} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-6 py-4 font-medium text-gray-900">
                        {device.name}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-gray-700">
                        {branchDisplay}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 font-mono text-xs text-gray-500">
                        {device.auth_user_id ?? 'Chưa ghép nối'}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4 text-gray-600">
                        {new Date(device.created_at).toLocaleString('vi-VN')}
                      </td>
                      <td className="whitespace-nowrap px-6 py-4">
                        {isRevoked ? (
                          <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-800">
                            Đã thu hồi ({new Date(device.revoked_at!).toLocaleDateString('vi-VN')})
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                            Đang hoạt động
                          </span>
                        )}
                      </td>
                      {isAdmin && (
                        <td className="whitespace-nowrap px-6 py-4 text-right">
                          {!isRevoked ? (
                  <div className="flex justify-end gap-2">
                    <button
                    type="button"
                    onClick={() => handleRegenerateClick(device)}
                 disabled={regenerateCodeMutation.isPending}
                              className="rounded-md bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                            >
                  Tạo mã ghép nối
                            </button>
                    <button
                              type="button"
                              onClick={() => handleRevokeClick(device)}
                              disabled={revokeDeviceMutation.isPending}
                              className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
                            >
                              Thu hồi
                            </button>
                  </div>
                          ) : (
                            <span className="text-xs text-gray-400">Đã vô hiệu</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
