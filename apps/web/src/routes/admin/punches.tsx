import React, { useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Database } from '@timekeeping/shared/database.types';
import { useAuth } from '../../lib/auth-context';
import { supabase } from '../../lib/supabase';

// Route con chỉ trả về nội dung; ProtectedRoute và AdminLayout do route cha /admin quản lý
export const Route = createFileRoute('/admin/punches')({ component: AdminPunchesComponent });

type PunchRow = Database['public']['Tables']['punches']['Row'];
type PunchType = Database['public']['Enums']['punch_type'];
type BranchRow = Pick<Database['public']['Tables']['branches']['Row'], 'id' | 'code' | 'name'>;

const PUNCH_TYPES: { value: PunchType; label: string }[] = [
  { value: 'clock_in', label: 'Vào ca (clock_in)' },
  { value: 'break_start', label: 'Bắt đầu nghỉ (break_start)' },
  { value: 'break_end', label: 'Kết thúc nghỉ (break_end)' },
  { value: 'clock_out', label: 'Ra ca (clock_out)' },
];

const HCM_OFFSET_MS = 7 * 60 * 60 * 1000;
const ACTIVE_SESSION_WINDOW_HOURS = 16;

// Chuyển đổi ISO timestamp sang định dạng input datetime-local cố định theo múi giờ Asia/Ho_Chi_Minh (+07:00)
function toHoChiMinhDatetimeLocal(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  const hcmDate = new Date(date.getTime() + HCM_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${hcmDate.getUTCFullYear()}-${pad(hcmDate.getUTCMonth() + 1)}-${pad(hcmDate.getUTCDate())}T${pad(hcmDate.getUTCHours())}:${pad(hcmDate.getUTCMinutes())}`;
}

// Chuyển đổi chuỗi datetime-local (hiểu theo Asia/Ho_Chi_Minh +07:00) sang UTC ISO string để truyền vào RPC
function fromHoChiMinhDatetimeLocalToIso(localInput: string): string | null {
  const trimmed = localInput.trim();
  if (!trimmed) return null;
  const withOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed}:00+07:00`
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)
    ? `${trimmed}+07:00`
    : null;
  if (!withOffset) return null;
  const parsed = new Date(withOffset);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function formatTimestamp(isoString: string | null): string {
  if (!isoString) return '-';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return date.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function extractErrorMessage(err: unknown): string {
  if (!err) return 'Đã xảy ra lỗi không xác định.';
  if (typeof err === 'object' && err !== null) {
    const maybeErr = err as { message?: string; details?: string; code?: string };
    if (maybeErr.message) {
      return maybeErr.details ? `${maybeErr.message} (${maybeErr.details})` : maybeErr.message;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function AdminPunchesComponent() {
  const { user, role } = useAuth();
  const queryClient = useQueryClient();

  // Trạng thái thực tế của kênh Realtime (SUBSCRIBED vs chưa kết nối)
  const [realtimeStatus, setRealtimeStatus] = useState<string>('CLOSED');

  // Bộ lọc danh sách chấm công: branch, employee_id (UUID), date
  const [filterBranchId, setFilterBranchId] = useState<string>('');
  const [filterEmployeeId, setFilterEmployeeId] = useState<string>('');
  const [filterDate, setFilterDate] = useState<string>('');

  // Bản ghi chấm công đang chọn để đính chính (correct_punch) hoặc hủy (void_punch)
  const [selectedPunchId, setSelectedPunchId] = useState<string | null>(null);

  // Form đính chính giờ chấm công (correct_punch)
  const [correctNewAt, setCorrectNewAt] = useState<string>('');
  const [correctReason, setCorrectReason] = useState<string>('');
  const [correctError, setCorrectError] = useState<string | null>(null);
  const [correctSuccess, setCorrectSuccess] = useState<string | null>(null);

  // Form hủy chấm công (void_punch)
  const [voidReason, setVoidReason] = useState<string>('');
  const [voidError, setVoidError] = useState<string | null>(null);
  const [voidSuccess, setVoidSuccess] = useState<string | null>(null);

  // Form thêm chấm công thủ công (add_manual_punch)
  const [manualEmployeeId, setManualEmployeeId] = useState<string>('');
  const [manualBranchId, setManualBranchId] = useState<string>('');
  const [manualType, setManualType] = useState<PunchType>('clock_in');
  const [manualAt, setManualAt] = useState<string>(() =>
    toHoChiMinhDatetimeLocal(new Date().toISOString())
  );
  const [manualReason, setManualReason] = useState<string>('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualSuccess, setManualSuccess] = useState<string | null>(null);

  // Bảo mật & phân quyền chi nhánh: Manager chỉ tải chi nhánh được phân công qua manager_branches; Admin tải toàn bộ branches
  const branchesQuery = useQuery<BranchRow[], Error>({
    queryKey: ['admin-punch-branches', role, user?.id],
    enabled: Boolean(user?.id && (role === 'admin' || role === 'manager')),
    queryFn: async () => {
      if (!user?.id) return [];

      if (role === 'manager') {
        const { data: assigned, error: assignedErr } = await supabase
          .from('manager_branches')
          .select('branch_id')
          .eq('manager_id', user.id);

        if (assignedErr) throw assignedErr;
        const branchIds = (assigned ?? []).map((row) => row.branch_id);
        if (branchIds.length === 0) return [];

        const { data, error } = await supabase
          .from('branches')
          .select('id, code, name')
          .in('id', branchIds)
          .order('code', { ascending: true });

        if (error) throw error;
        return data ?? [];
      }

      const { data, error } = await supabase
        .from('branches')
        .select('id, code, name')
        .order('code', { ascending: true });

      if (error) throw error;
      return data ?? [];
    },
  });

  const branches = branchesQuery.data ?? [];

  const branchMap = useMemo(() => {
    const map = new Map<string, BranchRow>();
    for (const b of branches) {
      map.set(b.id, b);
    }
    return map;
  }, [branches]);

  useEffect(() => {
    if (!manualBranchId && branches[0]) {
      setManualBranchId(branches[0].id);
    }
  }, [branches, manualBranchId]);

  // Truy vấn độc lập cho Widget Đang làm việc: lấy các punch chưa hủy trong 16 giờ gần nhất (theo chuẩn kiosk) thuộc phạm vi RLS và chi nhánh đang lọc
  const workingPunchesQuery = useQuery<PunchRow[], Error>({
    queryKey: ['admin-working-punches', filterBranchId],
    enabled: Boolean(user?.id && (role === 'admin' || role === 'manager')),
    queryFn: async () => {
      const cutoffIso = new Date(
        Date.now() - ACTIVE_SESSION_WINDOW_HOURS * 60 * 60 * 1000
      ).toISOString();

      let query = supabase
        .from('punches')
        .select(
          'id, employee_id, device_id, branch_id, type, at, source, created_by, reason, corrects_punch_id, voided_at, voided_by, created_at'
        )
        .is('voided_at', null)
        .gte('at', cutoffIso)
        .order('at', { ascending: false })
        .order('created_at', { ascending: false });

      if (filterBranchId) {
        query = query.eq('branch_id', filterBranchId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });

  // Bảo mật RLS: Không join bảng employees vì Manager không có quyền đọc hồ sơ nhân sự; chỉ truy vấn trực tiếp bảng punches và hiển thị UUID
  const punchesQuery = useQuery<PunchRow[], Error>({
    queryKey: ['admin-punches', filterBranchId, filterEmployeeId.trim(), filterDate],
    enabled: Boolean(user?.id && (role === 'admin' || role === 'manager')),
    queryFn: async () => {
      let query = supabase
        .from('punches')
        .select(
          'id, employee_id, device_id, branch_id, type, at, source, created_by, reason, corrects_punch_id, voided_at, voided_by, created_at'
        )
        .order('at', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(300);

      if (filterBranchId) {
        query = query.eq('branch_id', filterBranchId);
      }

      const trimmedEmpId = filterEmployeeId.trim();
      if (trimmedEmpId) {
        query = query.eq('employee_id', trimmedEmpId);
      }

      if (filterDate) {
        const startIso = new Date(`${filterDate}T00:00:00+07:00`).toISOString();
        const endIso = new Date(`${filterDate}T23:59:59.999+07:00`).toISOString();
        query = query.gte('at', startIso).lte('at', endIso);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });

  // Realtime: Theo dõi trạng thái kết nối thực tế của channel, làm mới cả 2 truy vấn khi bảng punches thay đổi và hủy channel khi unmount
  useEffect(() => {
    if (!user?.id) {
      setRealtimeStatus('CLOSED');
      return;
    }

    setRealtimeStatus('CONNECTING');

    const channel = supabase
      .channel('admin-punches-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'punches',
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['admin-punches'] });
          queryClient.invalidateQueries({ queryKey: ['admin-working-punches'] });
        }
      )
      .subscribe((status) => {
        setRealtimeStatus(status);
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, queryClient]);

  const punches = punchesQuery.data ?? [];
  const workingWindowPunches = workingPunchesQuery.data ?? [];

  // Realtime Widget: Tính danh sách nhân sự đang làm việc từ truy vấn 16h riêng biệt, chọn sự kiện chưa hủy mới nhất trên mỗi cặp chi nhánh + nhân viên
  const currentWorkingList = useMemo(() => {
    const latestByBranchEmployee = new Map<string, PunchRow>();

    for (const punch of workingWindowPunches) {
      if (punch.voided_at !== null) continue;
      if (filterBranchId && punch.branch_id !== filterBranchId) continue;

      const key = `${punch.branch_id}:${punch.employee_id}`;
      const existing = latestByBranchEmployee.get(key);
      if (!existing) {
        latestByBranchEmployee.set(key, punch);
      } else {
        const punchTime = new Date(punch.at).getTime();
        const existingTime = new Date(existing.at).getTime();
        if (
          punchTime > existingTime ||
          (punchTime === existingTime &&
            new Date(punch.created_at).getTime() > new Date(existing.created_at).getTime())
        ) {
          latestByBranchEmployee.set(key, punch);
        }
      }
    }

    const activeWorkers: {
      punch: PunchRow;
      state: 'working' | 'on_break';
    }[] = [];

    for (const latestPunch of latestByBranchEmployee.values()) {
      if (latestPunch.type === 'clock_in' || latestPunch.type === 'break_end') {
        activeWorkers.push({ punch: latestPunch, state: 'working' });
      } else if (latestPunch.type === 'break_start') {
        activeWorkers.push({ punch: latestPunch, state: 'on_break' });
      }
    }

    return activeWorkers.sort(
      (a, b) => new Date(b.punch.at).getTime() - new Date(a.punch.at).getTime()
    );
  }, [workingWindowPunches, filterBranchId]);

  const selectedPunch = useMemo(
    () => punches.find((p) => p.id === selectedPunchId) ?? null,
    [punches, selectedPunchId]
  );

  // Bảo mật: Manager không được phép sửa/hủy/thêm chấm công của chính mình (UI chặn + DB kiểm tra)
  const isOwnPunch = (employeeId: string): boolean => {
    return role === 'manager' && Boolean(user?.id) && employeeId.toLowerCase() === user!.id.toLowerCase();
  };

  const canMutatePunch = (punch: PunchRow | null): boolean => {
    if (!punch) return false;
    if (punch.voided_at !== null) return false;
    if (isOwnPunch(punch.employee_id)) return false;
    return true;
  };

  const isManualSelfPunch =
    role === 'manager' &&
    Boolean(user?.id) &&
    manualEmployeeId.trim().toLowerCase() === user!.id.toLowerCase();

  const handleSelectPunch = (punch: PunchRow) => {
    if (!canMutatePunch(punch)) return;
    setSelectedPunchId(punch.id);
    setCorrectNewAt(toHoChiMinhDatetimeLocal(punch.at));
    setCorrectReason('');
    setVoidReason('');
    setCorrectError(null);
    setCorrectSuccess(null);
    setVoidError(null);
    setVoidSuccess(null);
  };

  const invalidateAllPunchQueries = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-punches'] });
    queryClient.invalidateQueries({ queryKey: ['admin-working-punches'] });
  };

  // Audit: Đính chính chấm công qua RPC correct_punch (tự động hủy bản cũ, tạo bản mới và ghi nhận lý do vào audit_log)
  const correctPunchMutation = useMutation({
    mutationFn: async (params: { p_punch_id: string; p_new_at: string; p_reason: string }) => {
      const { data, error } = await supabase.rpc('correct_punch', {
        p_punch_id: params.p_punch_id,
        p_new_at: params.p_new_at,
        p_reason: params.p_reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (newPunchId) => {
      setCorrectError(null);
      setCorrectSuccess(`Đã đính chính thành công. ID chấm công mới: ${newPunchId}`);
      setCorrectReason('');
      setSelectedPunchId(null);
      invalidateAllPunchQueries();
    },
    onError: (err: unknown) => {
      setCorrectSuccess(null);
      setCorrectError(extractErrorMessage(err));
    },
  });

  // Audit: Thêm chấm công thủ công qua RPC add_manual_punch với lý do bắt buộc
  const addManualPunchMutation = useMutation({
    mutationFn: async (params: {
      p_employee_id: string;
      p_branch_id: string;
      p_type: PunchType;
      p_at: string;
      p_reason: string;
    }) => {
      const { data, error } = await supabase.rpc('add_manual_punch', {
        p_employee_id: params.p_employee_id,
        p_branch_id: params.p_branch_id,
        p_type: params.p_type,
        p_at: params.p_at,
        p_reason: params.p_reason,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (createdPunchId) => {
      setManualError(null);
      setManualSuccess(`Đã thêm chấm công thủ công thành công. ID: ${createdPunchId}`);
      setManualReason('');
      invalidateAllPunchQueries();
    },
    onError: (err: unknown) => {
      setManualSuccess(null);
      setManualError(extractErrorMessage(err));
    },
  });

  // Audit: Hủy mềm chấm công qua RPC void_punch với lý do bắt buộc (không xóa dữ liệu gốc)
  const voidPunchMutation = useMutation({
    mutationFn: async (params: { p_punch_id: string; p_reason: string }) => {
      const { error } = await supabase.rpc('void_punch', {
        p_punch_id: params.p_punch_id,
        p_reason: params.p_reason,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setVoidError(null);
      setVoidSuccess('Đã hủy bản ghi chấm công thành công.');
      setVoidReason('');
      setSelectedPunchId(null);
      invalidateAllPunchQueries();
    },
    onError: (err: unknown) => {
      setVoidSuccess(null);
      setVoidError(extractErrorMessage(err));
    },
  });

  const handleCorrectSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCorrectError(null);
    setCorrectSuccess(null);

    if (!selectedPunch || selectedPunch.voided_at !== null) {
      setCorrectError('Vui lòng chọn một bản ghi chấm công đang hoạt động (chưa hủy).');
      return;
    }
    if (isOwnPunch(selectedPunch.employee_id)) {
      setCorrectError('Quản lý không được phép đính chính chấm công của chính mình.');
      return;
    }
    const trimmedReason = correctReason.trim();
    if (!trimmedReason) {
      setCorrectError('Vui lòng nhập lý do đính chính chấm công.');
      return;
    }
    const newAtIso = fromHoChiMinhDatetimeLocalToIso(correctNewAt);
    if (!newAtIso) {
      setCorrectError('Thời gian đính chính không hợp lệ (múi giờ Asia/Ho_Chi_Minh +07:00).');
      return;
    }

    correctPunchMutation.mutate({
      p_punch_id: selectedPunch.id,
      p_new_at: newAtIso,
      p_reason: trimmedReason,
    });
  };

  const handleVoidSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setVoidError(null);
    setVoidSuccess(null);

    if (!selectedPunch || selectedPunch.voided_at !== null) {
      setVoidError('Vui lòng chọn một bản ghi chấm công đang hoạt động (chưa hủy).');
      return;
    }
    if (isOwnPunch(selectedPunch.employee_id)) {
      setVoidError('Quản lý không được phép hủy chấm công của chính mình.');
      return;
    }
    const trimmedReason = voidReason.trim();
    if (!trimmedReason) {
      setVoidError('Vui lòng nhập lý do hủy chấm công.');
      return;
    }

    voidPunchMutation.mutate({
      p_punch_id: selectedPunch.id,
      p_reason: trimmedReason,
    });
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setManualError(null);
    setManualSuccess(null);

    const trimmedEmployeeId = manualEmployeeId.trim();
    if (!trimmedEmployeeId) {
      setManualError('Vui lòng nhập UUID nhân viên (employee_id).');
      return;
    }
    if (isOwnPunch(trimmedEmployeeId)) {
      setManualError('Quản lý không được phép thêm chấm công thủ công cho chính mình.');
      return;
    }
    if (!manualBranchId) {
      setManualError('Vui lòng chọn chi nhánh (branch_id).');
      return;
    }
    const manualAtIso = fromHoChiMinhDatetimeLocalToIso(manualAt);
    if (!manualAtIso) {
      setManualError('Thời gian chấm công không hợp lệ (múi giờ Asia/Ho_Chi_Minh +07:00).');
      return;
    }
    const trimmedReason = manualReason.trim();
    if (!trimmedReason) {
      setManualError('Vui lòng nhập lý do thêm chấm công thủ công.');
      return;
    }

    addManualPunchMutation.mutate({
      p_employee_id: trimmedEmployeeId,
      p_branch_id: manualBranchId,
      p_type: manualType,
      p_at: manualAtIso,
      p_reason: trimmedReason,
    });
  };

  const isRealtimeConnected = realtimeStatus === 'SUBSCRIBED';

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Vận hành Dữ liệu Chấm công</h2>
          <p className="text-sm text-gray-600">
            Giám sát thời gian thực, thêm chấm công thủ công, đính chính hoặc hủy bản ghi kèm nhật ký kiểm toán (audit).
          </p>
        </div>
        <div
          className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border ${
            isRealtimeConnected
              ? 'text-green-700 bg-green-50 border-green-200'
              : 'text-amber-700 bg-amber-50 border-amber-200'
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              isRealtimeConnected ? 'bg-green-600 animate-pulse' : 'bg-amber-500'
            }`}
          />
          <span>
            {isRealtimeConnected
              ? 'Realtime đã kết nối (SUBSCRIBED)'
              : `Realtime chưa kết nối (${realtimeStatus})`}
          </span>
        </div>
      </div>

      {/* Widget Realtime: Nhân sự đang trong ca làm việc dựa trên truy vấn 16 giờ gần nhất độc lập với bộ lọc ngày/nhân viên */}
      <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 shadow-sm">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between mb-3">
          <h3 className="text-sm font-semibold text-blue-900">
            Trạng thái Đang làm việc Thời gian thực ({currentWorkingList.length})
          </h3>
          <span className="text-xs text-blue-700">
            Phiên trong {ACTIVE_SESSION_WINDOW_HOURS}h gần nhất (punch chưa hủy mới nhất mỗi nhân viên theo chi nhánh)
          </span>
        </div>

        {workingPunchesQuery.isError && (
          <div role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
            Lỗi tải trạng thái đang làm việc: {extractErrorMessage(workingPunchesQuery.error)}
          </div>
        )}

        {currentWorkingList.length === 0 ? (
          <p className="text-xs text-gray-600">
            {workingPunchesQuery.isLoading
              ? 'Đang tải trạng thái nhân sự đang làm việc...'
              : 'Hiện không có nhân sự nào đang trong trạng thái làm việc / nghỉ giữa ca trong 16 giờ qua.'}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {currentWorkingList.map(({ punch, state }) => {
              const branch = branchMap.get(punch.branch_id);
              return (
                <div
                  key={`${punch.branch_id}:${punch.employee_id}`}
                  className="flex flex-col justify-between rounded border border-white bg-white p-3 shadow-xs text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 font-medium ${
                        state === 'working'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {state === 'working' ? 'Đang làm việc' : 'Đang nghỉ giữa ca'} ({punch.type})
                    </span>
                    <span className="text-gray-500">{formatTimestamp(punch.at)}</span>
                  </div>
                  <div className="mt-2 space-y-1 font-mono text-[11px] text-gray-700 break-all">
                    <div>
                      <span className="font-sans font-medium text-gray-500">employee_id: </span>
                      {punch.employee_id}
                    </div>
                    <div>
                      <span className="font-sans font-medium text-gray-500">branch_id: </span>
                      {punch.branch_id}
                      {branch ? ` (${branch.code} - ${branch.name})` : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bộ lọc: branch, employee_id, date */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-800 mb-3">Bộ lọc Chấm công</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div>
            <label htmlFor="filter-branch" className="block text-xs font-medium text-gray-700 mb-1">
              Chi nhánh (branch_id)
            </label>
            <select
              id="filter-branch"
              value={filterBranchId}
              onChange={(e) => setFilterBranchId(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="">Tất cả chi nhánh được phân quyền</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} - {b.name} ({b.id})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="filter-employee" className="block text-xs font-medium text-gray-700 mb-1">
              UUID Nhân viên (employee_id)
            </label>
            <input
              id="filter-employee"
              type="text"
              value={filterEmployeeId}
              onChange={(e) => setFilterEmployeeId(e.target.value)}
              placeholder="Nhập đúng UUID nhân viên..."
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm font-mono focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="filter-date" className="block text-xs font-medium text-gray-700 mb-1">
              Ngày chấm công (date)
            </label>
            <input
              id="filter-date"
              type="date"
              value={filterDate}
              onChange={(e) => setFilterDate(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => {
                setFilterBranchId('');
                setFilterEmployeeId('');
                setFilterDate('');
              }}
              className="rounded border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              Xóa lọc
            </button>
            <button
              type="button"
              onClick={() => {
                punchesQuery.refetch();
                workingPunchesQuery.refetch();
              }}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              Làm mới
            </button>
          </div>
        </div>
      </div>

      {/* Khu vực 3 biểu mẫu thao tác: Thêm thủ công, Đính chính punch đang chọn, Hủy punch đang chọn */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* 1. Form thêm chấm công thủ công (add_manual_punch) */}
        <form
          onSubmit={handleManualSubmit}
          className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm space-y-3"
        >
          <h3 className="text-base font-semibold text-gray-800">
            Thêm Chấm công Thủ công (add_manual_punch)
          </h3>

          {manualError && (
            <div role="alert" className="rounded border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
              {manualError}
            </div>
          )}
          {manualSuccess && (
            <div className="rounded border border-green-200 bg-green-50 p-2.5 text-xs text-green-700">
              {manualSuccess}
            </div>
          )}

          <div>
            <label htmlFor="manual-employee-id" className="block text-xs font-medium text-gray-700 mb-1">
              UUID Nhân viên (p_employee_id) *
            </label>
            <input
              id="manual-employee-id"
              type="text"
              required
              value={manualEmployeeId}
              onChange={(e) => setManualEmployeeId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-xs font-mono focus:border-blue-500 focus:outline-none"
            />
            {isManualSelfPunch && (
              <p className="mt-1 text-xs text-red-600">
                Bảo mật: Quản lý không được thêm chấm công cho chính mình.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="manual-branch-id" className="block text-xs font-medium text-gray-700 mb-1">
              Chi nhánh (p_branch_id) *
            </label>
            <select
              id="manual-branch-id"
              required
              value={manualBranchId}
              onChange={(e) => setManualBranchId(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
            >
              <option value="">-- Chọn chi nhánh --</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} - {b.name} ({b.id})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="manual-type" className="block text-xs font-medium text-gray-700 mb-1">
              Loại chấm công (p_type) *
            </label>
            <select
              id="manual-type"
              required
              value={manualType}
              onChange={(e) => setManualType(e.target.value as PunchType)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
            >
              {PUNCH_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="manual-at" className="block text-xs font-medium text-gray-700 mb-1">
              Thời điểm (p_at - giờ VN +07:00) *
            </label>
            <input
              id="manual-at"
              type="datetime-local"
              required
              value={manualAt}
              onChange={(e) => setManualAt(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="manual-reason" className="block text-xs font-medium text-gray-700 mb-1">
              Lý do (p_reason - bắt buộc) *
            </label>
            <textarea
              id="manual-reason"
              required
              rows={2}
              value={manualReason}
              onChange={(e) => setManualReason(e.target.value)}
              placeholder="Nhập lý do bổ sung chấm công thủ công..."
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={
              addManualPunchMutation.isPending ||
              isManualSelfPunch ||
              !manualEmployeeId.trim() ||
              !manualBranchId ||
              !manualAt ||
              !manualReason.trim()
            }
            className="w-full rounded bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {addManualPunchMutation.isPending ? 'Đang lưu...' : 'Thêm Chấm công Thủ công'}
          </button>
        </form>

        {/* 2. Form đính chính bản ghi đang chọn (correct_punch) */}
        <form
          onSubmit={handleCorrectSubmit}
          className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm space-y-3"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-gray-800">
              Đính chính Giờ (correct_punch)
            </h3>
            {selectedPunch && (
              <button
                type="button"
                onClick={() => setSelectedPunchId(null)}
                className="text-xs text-gray-500 hover:text-gray-700 underline"
              >
                Bỏ chọn
              </button>
            )}
          </div>

          {correctError && (
            <div role="alert" className="rounded border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
              {correctError}
            </div>
          )}
          {correctSuccess && (
            <div className="rounded border border-green-200 bg-green-50 p-2.5 text-xs text-green-700">
              {correctSuccess}
            </div>
          )}

          {selectedPunch ? (
            <div className="rounded bg-gray-50 p-2.5 text-xs space-y-1 border border-gray-200 font-mono break-all">
              <div>
                <span className="font-sans font-semibold text-gray-600">p_punch_id: </span>
                {selectedPunch.id}
              </div>
              <div>
                <span className="font-sans font-semibold text-gray-600">employee_id: </span>
                {selectedPunch.employee_id}
              </div>
              <div>
                <span className="font-sans font-semibold text-gray-600">Loại / Giờ cũ: </span>
                {selectedPunch.type} | {formatTimestamp(selectedPunch.at)}
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-500 italic">
              Chọn một bản ghi chấm công đang hoạt động (chưa hủy) từ bảng bên dưới để đính chính giờ.
            </p>
          )}

          <div>
            <label htmlFor="correct-new-at" className="block text-xs font-medium text-gray-700 mb-1">
              Thời gian mới (p_new_at - giờ VN +07:00) *
            </label>
            <input
              id="correct-new-at"
              type="datetime-local"
              required
              disabled={!canMutatePunch(selectedPunch)}
              value={correctNewAt}
              onChange={(e) => setCorrectNewAt(e.target.value)}
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none disabled:bg-gray-100"
            />
          </div>

          <div>
            <label htmlFor="correct-reason" className="block text-xs font-medium text-gray-700 mb-1">
              Lý do đính chính (p_reason - bắt buộc) *
            </label>
            <textarea
              id="correct-reason"
              required
              rows={2}
              disabled={!canMutatePunch(selectedPunch)}
              value={correctReason}
              onChange={(e) => setCorrectReason(e.target.value)}
              placeholder="Nhập lý do đính chính giờ chấm công..."
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none disabled:bg-gray-100"
            />
          </div>

          <button
            type="submit"
            disabled={
              correctPunchMutation.isPending ||
              !canMutatePunch(selectedPunch) ||
              !correctNewAt ||
              !correctReason.trim()
            }
            className="w-full rounded bg-amber-600 px-3 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {correctPunchMutation.isPending ? 'Đang đính chính...' : 'Xác nhận Đính chính'}
          </button>
        </form>

        {/* 3. Form hủy bản ghi đang chọn (void_punch) */}
        <form
          onSubmit={handleVoidSubmit}
          className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm space-y-3"
        >
          <h3 className="text-base font-semibold text-gray-800">
            Hủy Chấm công (void_punch)
          </h3>

          {voidError && (
            <div role="alert" className="rounded border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
              {voidError}
            </div>
          )}
          {voidSuccess && (
            <div className="rounded border border-green-200 bg-green-50 p-2.5 text-xs text-green-700">
              {voidSuccess}
            </div>
          )}

          {selectedPunch ? (
            <div className="rounded bg-red-50/60 p-2.5 text-xs space-y-1 border border-red-200 font-mono break-all">
              <div>
                <span className="font-sans font-semibold text-gray-700">p_punch_id: </span>
                {selectedPunch.id}
              </div>
              <div>
                <span className="font-sans font-semibold text-gray-700">employee_id: </span>
                {selectedPunch.employee_id}
              </div>
              <div>
                <span className="font-sans font-semibold text-gray-700">Loại / Giờ: </span>
                {selectedPunch.type} | {formatTimestamp(selectedPunch.at)}
              </div>
            </div>
          ) : (
            <p className="text-xs text-gray-500 italic">
              Chọn một bản ghi chấm công đang hoạt động (chưa hủy) từ bảng bên dưới để hủy mềm (void).
            </p>
          )}

          <div>
            <label htmlFor="void-reason" className="block text-xs font-medium text-gray-700 mb-1">
              Lý do hủy (p_reason - bắt buộc) *
            </label>
            <textarea
              id="void-reason"
              required
              rows={3}
              disabled={!canMutatePunch(selectedPunch)}
              value={voidReason}
              onChange={(e) => setVoidReason(e.target.value)}
              placeholder="Nhập lý do hủy bản ghi chấm công..."
              className="w-full rounded border border-gray-300 px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none disabled:bg-gray-100"
            />
          </div>

          <button
            type="submit"
            disabled={
              voidPunchMutation.isPending ||
              !canMutatePunch(selectedPunch) ||
              !voidReason.trim()
            }
            className="w-full rounded bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {voidPunchMutation.isPending ? 'Đang hủy...' : 'Xác nhận Hủy (Void)'}
          </button>
        </form>
      </div>

      {/* Bảng dữ liệu chấm công hiển thị đúng các cột: id, employee_id, branch_id, type, at, source, reason, voided_at, corrects_punch_id */}
      <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-800">
            Danh sách Bản ghi Chấm công ({punches.length})
          </h3>
          {punchesQuery.isFetching && (
            <span className="text-xs text-gray-500">Đang đồng bộ dữ liệu...</span>
          )}
        </div>

        {punchesQuery.isError && (
          <div role="alert" className="m-4 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            Lỗi tải dữ liệu chấm công: {extractErrorMessage(punchesQuery.error)}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200 text-left text-xs">
            <thead className="bg-gray-50 text-gray-600 uppercase">
              <tr>
                <th className="px-3 py-2.5 font-semibold">id</th>
                <th className="px-3 py-2.5 font-semibold">employee_id</th>
                <th className="px-3 py-2.5 font-semibold">branch_id</th>
                <th className="px-3 py-2.5 font-semibold">type</th>
                <th className="px-3 py-2.5 font-semibold">at</th>
                <th className="px-3 py-2.5 font-semibold">source</th>
                <th className="px-3 py-2.5 font-semibold">reason</th>
                <th className="px-3 py-2.5 font-semibold">voided_at</th>
                <th className="px-3 py-2.5 font-semibold">corrects_punch_id</th>
                <th className="px-3 py-2.5 font-semibold text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {punches.length === 0 && !punchesQuery.isLoading ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-gray-500">
                    Không tìm thấy bản ghi chấm công nào phù hợp với bộ lọc.
                  </td>
                </tr>
              ) : (
                punches.map((punch) => {
                  const isVoided = punch.voided_at !== null;
                  const ownPunch = isOwnPunch(punch.employee_id);
                  const isSelected = selectedPunchId === punch.id;
                  const branch = branchMap.get(punch.branch_id);

                  return (
                    <tr
                      key={punch.id}
                      className={`${
                        isSelected
                          ? 'bg-blue-50/80'
                          : isVoided
                          ? 'bg-gray-50 text-gray-400'
                          : 'hover:bg-gray-50'
                      }`}
                    >
                      <td className="px-3 py-2 font-mono text-[11px] break-all">{punch.id}</td>
                      <td className="px-3 py-2 font-mono text-[11px] break-all">
                        {punch.employee_id}
                        {ownPunch && (
                          <span className="ml-1 inline-block rounded bg-purple-100 px-1.5 py-0.5 font-sans text-[10px] text-purple-800">
                            Bản thân
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] break-all">
                        <div>{punch.branch_id}</div>
                        {branch && (
                          <div className="font-sans text-[10px] text-gray-500">
                            {branch.code} - {branch.name}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex rounded bg-gray-100 px-2 py-0.5 font-mono text-[11px] font-medium text-gray-800">
                          {punch.type}
                        </span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div>{formatTimestamp(punch.at)}</div>
                        <div className="font-mono text-[10px] text-gray-400">{punch.at}</div>
                      </td>
                      <td className="px-3 py-2 font-mono">{punch.source}</td>
                      <td className="px-3 py-2 max-w-xs break-words">{punch.reason ?? '-'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {punch.voided_at ? (
                          <span className="inline-flex flex-col text-red-600">
                            <span className="font-semibold">Đã hủy</span>
                            <span className="text-[10px]">{formatTimestamp(punch.voided_at)}</span>
                          </span>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] break-all">
                        {punch.corrects_punch_id ?? '-'}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        {isVoided ? (
                          <span className="text-[11px] text-gray-400 italic">Đã hủy</span>
                        ) : ownPunch ? (
                          <span
                            className="text-[11px] text-gray-400 italic"
                            title="Quản lý không được sửa/hủy chấm công của chính mình"
                          >
                            Không thể thao tác
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleSelectPunch(punch)}
                            className={`rounded px-2.5 py-1 text-xs font-medium ${
                              isSelected
                                ? 'bg-blue-700 text-white'
                                : 'border border-blue-600 text-blue-600 hover:bg-blue-50'
                            }`}
                          >
                            {isSelected ? 'Đang chọn' : 'Chọn sửa / hủy'}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
