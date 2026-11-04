import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useAuth } from '../../lib/auth-context';
import { supabase } from '../../lib/supabase';

type ShiftStatus = 'pending' | 'approved' | 'rejected';

const PAGE_SIZE = 25;

interface BranchOption {
  id: string;
  code: string;
  name: string;
}

interface ShiftRow {
  id: string;
  employee_id: string;
  branch_id: string;
  start_at: string;
  end_at: string;
  status: ShiftStatus;
  note: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
}

const vnTimeFormatter = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatVnDateTime(iso: string): string {
  return vnTimeFormatter.format(new Date(iso));
}

// Quy đổi ngày YYYY-MM-DD sang mốc đầu/cuối ngày theo múi giờ Asia/Ho_Chi_Minh (+07:00)
function toVnStartOfDayIso(dateStr: string): string {
  return `${dateStr}T00:00:00.000+07:00`;
}

function toVnEndOfDayIso(dateStr: string): string {
  return `${dateStr}T23:59:59.999+07:00`;
}

export const Route = createFileRoute('/admin/shifts')({ component: AdminShiftsComponent });

function AdminShiftsComponent() {
  const { user, role } = useAuth();
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [branchesReady, setBranchesReady] = useState(false);
  const [branchFilter, setBranchFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | ShiftStatus>('pending');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [realtimeStatus, setRealtimeStatus] = useState<string>('CONNECTING');
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Chi nhánh đích khi duyệt: chuỗi rỗng nghĩa là giữ nguyên chi nhánh hiện tại của từng ca
  const [approveBranchId, setApproveBranchId] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    let active = true;

    const loadBranches = async () => {
      if (!user || !role) return;
      setBranchesReady(false);
      setError(null);

      if (role === 'admin') {
        const { data, error: branchErr } = await supabase
          .from('branches')
          .select('id, code, name')
          .order('name');
        if (!active) return;
        if (branchErr) {
          setError(branchErr.message);
          setBranches([]);
        } else {
          setBranches(data ?? []);
        }
        setBranchesReady(true);
        return;
      }

      if (role === 'manager') {
        const { data: mappings, error: mapErr } = await supabase
          .from('manager_branches')
          .select('branch_id')
          .eq('manager_id', user.id);

        if (!active) return;
        if (mapErr) {
          setError(mapErr.message);
          setBranches([]);
          setBranchesReady(true);
          return;
        }

        const branchIds = (mappings ?? []).map((m) => m.branch_id);
        if (branchIds.length === 0) {
          setBranches([]);
          setBranchesReady(true);
          return;
        }

        const { data, error: branchErr } = await supabase
          .from('branches')
          .select('id, code, name')
          .in('id', branchIds)
          .order('name');

        if (!active) return;
        if (branchErr) {
          setError(branchErr.message);
          setBranches([]);
        } else {
          setBranches(data ?? []);
        }
        setBranchesReady(true);
      }
    };

    loadBranches();
    return () => {
      active = false;
    };
  }, [user, role]);

  const loadShifts = useCallback(async () => {
    if (!user || !role || !branchesReady) return;
    if (role === 'manager' && branches.length === 0) {
      setShifts([]);
      setTotalCount(0);
      setSelectedIds([]);
      setLoading(false);
      return;
    }

    if (startDate && endDate && startDate > endDate) {
      setError('Ngày bắt đầu không được lớn hơn ngày kết thúc.');
      setShifts([]);
      setTotalCount(0);
      setSelectedIds([]);
      setLoading(false);
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    const from = (page - 1) * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from('shifts')
      .select(
        'id, employee_id, branch_id, start_at, end_at, status, note, approved_by, approved_at, created_at',
        { count: 'exact' },
      )
      .order('start_at', { ascending: false })
      .order('id', { ascending: false });

    if (branchFilter !== 'all') {
      query = query.eq('branch_id', branchFilter);
    } else if (role === 'manager') {
      query = query.in(
        'branch_id',
        branches.map((b) => b.id),
      );
    }

    if (statusFilter !== 'all') {
      query = query.eq('status', statusFilter);
    }

    if (startDate) {
      query = query.gte('start_at', toVnStartOfDayIso(startDate));
    }

    if (endDate) {
      query = query.lte('start_at', toVnEndOfDayIso(endDate));
    }

    const { data, count, error: shiftErr } = await query.range(from, to);
    if (requestId !== requestIdRef.current) return;

    if (shiftErr) {
      setError(shiftErr.message);
      setShifts([]);
      setTotalCount(0);
    } else {
      const total = count ?? 0;
      const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
      if (page > maxPage) {
        setPage(maxPage);
        return;
      }
      setShifts(data ?? []);
      setTotalCount(total);
    }
    setSelectedIds([]);
    setLoading(false);
  }, [user, role, branches, branchesReady, branchFilter, statusFilter, startDate, endDate, page]);

  useEffect(() => {
    loadShifts();
  }, [loadShifts]);

  const loadShiftsRef = useRef(loadShifts);
  useEffect(() => {
    loadShiftsRef.current = loadShifts;
  }, [loadShifts]);

  // Đăng ký Realtime cho bảng shifts và dọn dẹp channel khi unmount
  useEffect(() => {
    if (!user || !role || !branchesReady) return;
    if (role === 'manager' && branches.length === 0) {
      setRealtimeStatus('CLOSED');
      return;
    }

    let active = true;
    setRealtimeStatus('CONNECTING');

    const channel = supabase
      .channel(`admin-shifts-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'shifts',
        },
        () => {
          if (active) {
            void loadShiftsRef.current();
          }
        },
      )
      .subscribe((status) => {
        if (active) {
          setRealtimeStatus(status);
        }
      });

    return () => {
      active = false;
      void supabase.removeChannel(channel);
    };
  }, [user, role, branchesReady, branches.length]);

  const branchMap = useMemo(() => {
    return new Map(branches.map((b) => [b.id, `${b.code} - ${b.name}`]));
  }, [branches]);

  // Quản lý không được tự duyệt hoặc từ chối ca làm việc của chính mình; chỉ Admin mới có quyền này.
  const canSelectShift = useCallback(
    (shift: ShiftRow) => shift.status === 'pending' && !(role === 'manager' && shift.employee_id === user?.id),
    [role, user?.id],
  );

  const selectableIds = useMemo(() => shifts.filter(canSelectShift).map((s) => s.id), [shifts, canSelectShift]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const handleBranchFilterChange = (value: string) => {
    setBranchFilter(value);
    setPage(1);
    setSelectedIds([]);
  };

  const handleStatusFilterChange = (value: 'all' | ShiftStatus) => {
    setStatusFilter(value);
    setPage(1);
    setSelectedIds([]);
  };

  const handleStartDateChange = (value: string) => {
    setStartDate(value);
    setPage(1);
    setSelectedIds([]);
  };

  const handleEndDateChange = (value: string) => {
    setEndDate(value);
    setPage(1);
    setSelectedIds([]);
  };

  const handlePageChange = (nextPage: number) => {
    setPage(nextPage);
    setSelectedIds([]);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  const toggleSelectAll = () => {
    if (selectableIds.length === 0) return;
    setSelectedIds((prev) => (prev.length === selectableIds.length ? [] : selectableIds));
  };

  const handleBatchAction = async (action: 'approve' | 'reject') => {
    if (selectedIds.length === 0) return;
    setSubmitting(true);
    setError(null);

    // Duyệt ca thông qua RPC approve_shifts_at_branch (p_branch_id = null để giữ nguyên, hoặc UUID để đổi chi nhánh hàng loạt)
    // Từ chối ca vẫn giữ nguyên RPC reject_shifts
    const { error: rpcErr } =
      action === 'approve'
        ? await supabase.rpc('approve_shifts_at_branch', {
            p_shift_ids: selectedIds,
            p_branch_id: approveBranchId || null,
          })
        : await supabase.rpc('reject_shifts', { p_shift_ids: selectedIds });

    setSubmitting(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }

    setSelectedIds([]);
    if (action === 'approve') {
      setApproveBranchId('');
    }
    await loadShifts();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold text-gray-800">Duyệt Ca làm việc</h2>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
              realtimeStatus === 'SUBSCRIBED'
                ? 'bg-green-100 text-green-800'
                : realtimeStatus === 'CHANNEL_ERROR' || realtimeStatus === 'TIMED_OUT'
                  ? 'bg-red-100 text-red-800'
                  : 'bg-gray-100 text-gray-700'
            }`}
          >
            {realtimeStatus === 'SUBSCRIBED'
              ? 'Realtime: Đã kết nối'
              : realtimeStatus === 'CHANNEL_ERROR' || realtimeStatus === 'TIMED_OUT'
                ? `Realtime: Lỗi (${realtimeStatus})`
                : `Realtime: ${realtimeStatus}`}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={branchFilter}
            onChange={(e) => handleBranchFilterChange(e.target.value)}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm"
          >
            <option value="all">Tất cả chi nhánh</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} - {b.name}
              </option>
            ))}
          </select>

          <select
            value={statusFilter}
            onChange={(e) => handleStatusFilterChange(e.target.value as 'all' | ShiftStatus)}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm"
          >
            <option value="all">Tất cả trạng thái</option>
            <option value="pending">Chờ duyệt (pending)</option>
            <option value="approved">Đã duyệt (approved)</option>
            <option value="rejected">Từ chối (rejected)</option>
          </select>

          <label className="flex items-center gap-1.5 text-sm text-gray-700">
            <span>Từ ngày:</span>
            <input
              type="date"
              aria-label="Từ ngày"
              value={startDate}
              onChange={(e) => handleStartDateChange(e.target.value)}
              className="rounded border border-gray-300 bg-white px-2.5 py-1.5 text-sm"
            />
          </label>

          <label className="flex items-center gap-1.5 text-sm text-gray-700">
            <span>Đến ngày:</span>
            <input
              type="date"
              aria-label="Đến ngày"
              value={endDate}
              onChange={(e) => handleEndDateChange(e.target.value)}
              className="rounded border border-gray-300 bg-white px-2.5 py-1.5 text-sm"
            />
          </label>

          <button
            type="button"
            onClick={loadShifts}
            disabled={loading || submitting}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            Làm mới
          </button>

          <label className="flex items-center gap-1.5 text-sm text-gray-700">
            <span>Chi nhánh khi duyệt:</span>
            <select
              aria-label="Chi nhánh khi duyệt"
              value={approveBranchId}
              onChange={(e) => setApproveBranchId(e.target.value)}
              disabled={submitting}
              className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm disabled:opacity-50"
            >
              <option value="">Giữ nguyên chi nhánh</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} - {b.name}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => handleBatchAction('approve')}
            disabled={selectedIds.length === 0 || submitting}
            className="rounded bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            Duyệt ({selectedIds.length})
          </button>
          <button
            type="button"
            onClick={() => handleBatchAction('reject')}
            disabled={selectedIds.length === 0 || submitting}
            className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            Từ chối ({selectedIds.length})
          </button>
        </div>
      </div>

      {approveBranchId && (
        <div className="rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          Đang chọn đổi sang chi nhánh <strong>{branchMap.get(approveBranchId) ?? approveBranchId}</strong>: thao tác
          duyệt sẽ áp dụng chuyển chi nhánh này cho toàn bộ <strong>{selectedIds.length}</strong> ca đang chọn.
        </div>
      )}

      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        {loading ? (
          <p className="p-6 text-sm text-gray-500">Đang tải danh sách ca làm việc...</p>
        ) : shifts.length === 0 ? (
          <p className="p-6 text-sm text-gray-500">Không có ca làm việc nào phù hợp.</p>
        ) : (
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-left text-xs font-semibold uppercase text-gray-600">
              <tr>
                <th className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selectableIds.length > 0 && selectedIds.length === selectableIds.length}
                    disabled={selectableIds.length === 0}
                    onChange={toggleSelectAll}
                  />
                </th>
                <th className="px-4 py-3">Nhân viên (UUID)</th>
                <th className="px-4 py-3">Chi nhánh</th>
                <th className="px-4 py-3">Bắt đầu (VN)</th>
                <th className="px-4 py-3">Kết thúc (VN)</th>
                <th className="px-4 py-3">Trạng thái</th>
                <th className="px-4 py-3">Ghi chú</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {shifts.map((shift) => {
                const selectable = canSelectShift(shift);
                const isSelfPending = shift.status === 'pending' && role === 'manager' && shift.employee_id === user?.id;
                return (
                  <tr key={shift.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(shift.id)}
                        disabled={!selectable}
                        title={isSelfPending ? 'Quản lý không được tự duyệt ca của chính mình' : undefined}
                        onChange={() => toggleSelect(shift.id)}
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-800">{shift.employee_id}</td>
                    <td className="px-4 py-3 text-gray-700">{branchMap.get(shift.branch_id) ?? shift.branch_id}</td>
                    <td className="px-4 py-3 text-gray-700">{formatVnDateTime(shift.start_at)}</td>
                    <td className="px-4 py-3 text-gray-700">{formatVnDateTime(shift.end_at)}</td>
                    <td className="px-4 py-3 font-medium text-gray-800">{shift.status}</td>
                    <td className="px-4 py-3 text-gray-600">{shift.note ?? '-'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
        <div>
          Tổng cộng <span className="font-semibold text-gray-800">{totalCount}</span> ca làm việc (Trang{' '}
          <span className="font-semibold text-gray-800">{page}</span>/{totalPages}, tối đa {PAGE_SIZE} dòng/trang)
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handlePageChange(Math.max(1, page - 1))}
            disabled={page <= 1 || loading || submitting}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            Trang trước
          </button>
          <button
            type="button"
            onClick={() => handlePageChange(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages || loading || submitting}
            className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            Trang sau
          </button>
        </div>
      </div>
    </div>
  );
}
