import { useState, useEffect, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Database } from '@timekeeping/shared/database.types';
import { useAuth } from '../../../lib/auth-context';
import { supabase } from '../../../lib/supabase';

export const Route = createFileRoute('/admin/payroll/allowances')({
  component: PayrollAllowancesPage,
});

type PayrollPeriod = Database['public']['Tables']['payroll_periods']['Row'];
type ActiveEmployee = Pick<
  Database['public']['Tables']['employees']['Row'],
  'id' | 'employee_code' | 'full_name' | 'role' | 'is_active'
>;
type MonthlyAllowanceItem = Pick<
  Database['public']['Tables']['monthly_allowances']['Row'],
  'id' | 'period_id' | 'employee_id' | 'amount' | 'reason' | 'created_at'
> & {
  employees: Pick<Database['public']['Tables']['employees']['Row'], 'employee_code' | 'full_name'> | null;
};

const vndFormatter = new Intl.NumberFormat('vi-VN');

function getVietnamYearMonth(): { year: string; month: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value ?? String(new Date().getFullYear());
  const month = parts.find((p) => p.type === 'month')?.value ?? String(new Date().getMonth() + 1);
  return { year, month };
}

function PayrollAllowancesPage() {
  const { user, role } = useAuth();
  const qc = useQueryClient();
  const isAdmin = role === 'admin';

  const [periodForm, setPeriodForm] = useState(getVietnamYearMonth);
  const [selectedPeriodId, setSelectedPeriodId] = useState<string>('');
  const [allowanceForm, setAllowanceForm] = useState({
    employeeId: '',
    amount: '',
    reason: '',
  });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // Truy vấn danh sách kỳ lương, sắp xếp giảm dần theo năm và tháng mới nhất
  const periodsKey = ['payroll-periods', user?.id, role];
  const {
    data: periods = [],
    isLoading: periodsLoading,
    error: periodsError,
  } = useQuery({
    queryKey: periodsKey,
    enabled: !!user && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payroll_periods')
        .select('id,year,month,status,approved_by,approved_at,created_at')
        .order('year', { ascending: false })
        .order('month', { ascending: false });
      if (error) throw error;
      return (data ?? []) as PayrollPeriod[];
    },
  });

  // Tự động chọn kỳ lương đang mở mới nhất nếu có, ngược lại chọn kỳ lương mới nhất
  useEffect(() => {
    if (!selectedPeriodId && periods.length > 0) {
      const target = periods.find((p) => p.status === 'open') ?? periods[0];
      if (target) setSelectedPeriodId(target.id);
    }
  }, [periods, selectedPeriodId]);

  const selectedPeriod = periods.find((p) => p.id === selectedPeriodId) ?? null;
  const isPeriodOpen = selectedPeriod?.status === 'open';

  // Truy vấn danh sách nhân viên đang hoạt động để cấp phát phụ cấp
  const employeesKey = ['active-employees-allowance', user?.id, role];
  const {
    data: employees = [],
    isLoading: empLoading,
    error: empError,
  } = useQuery({
    queryKey: employeesKey,
    enabled: !!user && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select('id,employee_code,full_name,role,is_active')
        .eq('is_active', true)
        .order('employee_code', { ascending: true });
      if (error) throw error;
      return (data ?? []) as ActiveEmployee[];
    },
  });

  // Truy vấn phụ cấp hàng tháng của kỳ lương đang chọn (kèm mã và tên nhân viên)
  const allowancesKey = ['monthly-allowances', user?.id, selectedPeriodId];
  const {
    data: allowances = [],
    isLoading: allowLoading,
    error: allowError,
  } = useQuery({
    queryKey: allowancesKey,
    enabled: !!user && isAdmin && !!selectedPeriodId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('monthly_allowances')
        .select('id,period_id,employee_id,amount,reason,created_at,employees!monthly_allowances_employee_id_fkey(employee_code,full_name)')
        .eq('period_id', selectedPeriodId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as MonthlyAllowanceItem[];
    },
  });

  // Tạo kỳ lương mới ở trạng thái 'open' (kiểm tra trùng lặp năm/tháng)
  const createPeriodMut = useMutation({
    mutationFn: async ({ year, month }: { year: number; month: number }) => {
      if (!isAdmin) throw new Error('Chỉ quản trị viên mới có quyền tạo kỳ lương.');
      const { data, error } = await supabase
        .from('payroll_periods')
        .insert({ year, month, status: 'open' })
        .select('id,year,month,status,approved_by,approved_at,created_at')
        .single();
      if (error) {
        if (error.code === '23505') {
          throw new Error(`Kỳ lương tháng ${month}/${year} đã tồn tại.`);
        }
        throw error;
      }
      return data as PayrollPeriod;
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: periodsKey });
      setSelectedPeriodId(created.id);
      setErr('');
      setMsg(`Đã tạo kỳ lương tháng ${created.month}/${created.year}.`);
    },
    onError: (e: any) => {
      setMsg('');
      setErr(e.message || 'Không thể tạo kỳ lương.');
    },
  });

  // Thêm khoản phụ cấp mới: chỉ cho phép khi kỳ lương đang mở, số tiền > 0 và có lý do hợp lệ
  const addAllowanceMut = useMutation({
    mutationFn: async (payload: { period_id: string; employee_id: string; amount: number; reason: string }) => {
      if (!isAdmin) throw new Error('Chỉ quản trị viên mới có quyền thêm phụ cấp.');
      if (!isPeriodOpen) throw new Error('Kỳ lương đã chốt, không thể thêm phụ cấp.');
      const { data, error } = await supabase
        .from('monthly_allowances')
        .insert({
          period_id: payload.period_id,
          employee_id: payload.employee_id,
          amount: payload.amount,
          reason: payload.reason,
          created_by: user?.id ?? null,
        })
        .select('id')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: allowancesKey });
      setAllowanceForm((prev) => ({ ...prev, amount: '', reason: '' }));
      setErr('');
      setMsg('Đã thêm khoản phụ cấp.');
    },
    onError: (e: any) => {
      setMsg('');
      setErr(e.message || 'Không thể thêm khoản phụ cấp.');
    },
  });

  // Xóa khoản phụ cấp: RLS và client đều chặn nếu kỳ lương đã duyệt
  const deleteAllowanceMut = useMutation({
    mutationFn: async (allowanceId: string) => {
      if (!isAdmin) throw new Error('Chỉ quản trị viên mới có quyền xóa phụ cấp.');
      if (!isPeriodOpen) throw new Error('Kỳ lương đã duyệt, không thể xóa phụ cấp.');
      const { data, error } = await supabase
        .from('monthly_allowances')
        .delete()
        .eq('id', allowanceId)
        .eq('period_id', selectedPeriodId)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Không tìm thấy khoản phụ cấp hoặc kỳ lương đã khóa.');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: allowancesKey });
      setErr('');
      setMsg('Đã xóa khoản phụ cấp.');
    },
    onError: (e: any) => {
      setMsg('');
      setErr(e.message || 'Không thể xóa khoản phụ cấp.');
    },
  });

  const handleCreatePeriod = (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    const yearNum = Number(periodForm.year);
    const monthNum = Number(periodForm.month);
    if (!Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
      return setErr('Năm của kỳ lương phải nằm trong khoảng 2000 - 2100.');
    }
    if (!Number.isInteger(monthNum) || monthNum < 1 || monthNum > 12) {
      return setErr('Tháng của kỳ lương phải từ 1 đến 12.');
    }
    if (periods.some((p) => p.year === yearNum && p.month === monthNum)) {
      return setErr(`Kỳ lương tháng ${monthNum}/${yearNum} đã tồn tại.`);
    }
    createPeriodMut.mutate({ year: yearNum, month: monthNum });
  };

  const handleAddAllowance = (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setMsg('');
    if (!selectedPeriod || selectedPeriod.status !== 'open') {
      return setErr('Vui lòng chọn một kỳ lương đang mở để thêm phụ cấp.');
    }
    if (!allowanceForm.employeeId) {
      return setErr('Vui lòng chọn nhân viên đang hoạt động.');
    }
    const amountNum = Number(allowanceForm.amount);
    if (!Number.isFinite(amountNum) || !Number.isInteger(amountNum) || amountNum <= 0) {
      return setErr('Số tiền phụ cấp phải là số nguyên dương (VNĐ > 0).');
    }
    const trimmedReason = allowanceForm.reason.trim();
    if (!trimmedReason) {
      return setErr('Lý do phụ cấp là bắt buộc và không được để trống.');
    }
    addAllowanceMut.mutate({
      period_id: selectedPeriod.id,
      employee_id: allowanceForm.employeeId,
      amount: amountNum,
      reason: trimmedReason,
    });
  };

  if (!isAdmin) {
    return <div className="p-4 text-red-600">Bạn không có quyền truy cập phân hệ này.</div>;
  }

  if (periodsLoading || empLoading) {
    return <div className="p-4 text-gray-600">Đang tải dữ liệu kỳ lương và nhân sự...</div>;
  }

  const topError = periodsError || empError;
  if (topError) {
    return <div className="p-4 text-red-600">Lỗi tải dữ liệu: {(topError as any).message}</div>;
  }

  return (
    <div className="space-y-6">
      {err && <div className="p-3 bg-red-100 text-red-700 rounded border border-red-200 text-sm">{err}</div>}
      {msg && <div className="p-3 bg-green-100 text-green-700 rounded border border-green-200 text-sm">{msg}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Cột trái: Tạo và chọn kỳ lương */}
        <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm space-y-4">
          <h3 className="text-base font-bold text-gray-800">Danh sách Kỳ lương</h3>

          <form onSubmit={handleCreatePeriod} className="bg-gray-50 p-3 rounded border border-gray-200 space-y-3">
            <div className="text-xs font-semibold text-gray-700 uppercase">Tạo kỳ lương mới</div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Tháng (1-12)</label>
                <input
                  type="number"
                  min={1}
                  max={12}
                  required
                  value={periodForm.month}
                  onChange={(e) => setPeriodForm({ ...periodForm, month: e.target.value })}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Năm</label>
                <input
                  type="number"
                  min={2000}
                  max={2100}
                  required
                  value={periodForm.year}
                  onChange={(e) => setPeriodForm({ ...periodForm, year: e.target.value })}
                  className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={createPeriodMut.isPending}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-1.5 px-3 rounded disabled:opacity-50"
            >
              {createPeriodMut.isPending ? 'Đang tạo...' : 'Mở kỳ lương'}
            </button>
          </form>

          {periods.length === 0 ? (
            <div className="text-sm text-gray-500 py-4 text-center">Chưa có kỳ lương nào.</div>
          ) : (
            <div className="divide-y divide-gray-200 border border-gray-200 rounded max-h-96 overflow-y-auto">
              {periods.map((p) => {
                const isSelected = p.id === selectedPeriodId;
                const isOpen = p.status === 'open';
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setSelectedPeriodId(p.id);
                      setErr('');
                      setMsg('');
                    }}
                    className={`w-full text-left p-3 transition flex items-center justify-between ${
                      isSelected ? 'bg-blue-50 border-l-4 border-blue-600' : 'hover:bg-gray-50'
                    }`}
                  >
                    <div>
                      <div className="font-semibold text-sm text-gray-800">
                        Tháng {String(p.month).padStart(2, '0')}/{p.year}
                      </div>
                      {p.approved_at && (
                        <div className="text-xs text-gray-500 mt-0.5">
                          Duyệt lúc: {new Date(p.approved_at).toLocaleString('vi-VN')}
                        </div>
                      )}
                    </div>
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-medium ${
                        isOpen ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-700'
                      }`}
                    >
                      {isOpen ? 'Đang mở' : 'Đã duyệt'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Cột phải: Phụ cấp hàng tháng trong kỳ lương được chọn */}
        <div className="lg:col-span-2 bg-white border border-gray-200 rounded-lg p-4 shadow-sm space-y-4">
          {!selectedPeriod ? (
            <div className="text-sm text-gray-500 py-8 text-center">
              Vui lòng chọn hoặc tạo một kỳ lương ở cột bên trái để quản lý phụ cấp.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 pb-3">
                <div>
                  <h3 className="text-base font-bold text-gray-800">
                    Phụ cấp Tháng {String(selectedPeriod.month).padStart(2, '0')}/{selectedPeriod.year}
                  </h3>
                  <p className="text-xs text-gray-500">
                    {isPeriodOpen
                      ? 'Kỳ lương đang mở: Có thể thêm nhiều khoản phụ cấp riêng biệt cho từng nhân viên hoặc xóa khoản đã nhập.'
                      : `Kỳ lương đã duyệt${
                          selectedPeriod.approved_at
                            ? ` vào ${new Date(selectedPeriod.approved_at).toLocaleString('vi-VN')}`
                            : ''
                        }: Dữ liệu phụ cấp đã khóa, chỉ được phép xem.`}
                  </p>
                </div>
                <span
                  className={`text-xs px-2.5 py-1 rounded font-semibold ${
                    isPeriodOpen ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-700'
                  }`}
                >
                  {isPeriodOpen ? 'Trạng thái: Đang mở (Open)' : 'Trạng thái: Đã duyệt (Approved)'}
                </span>
              </div>

              {isPeriodOpen && (
                <form onSubmit={handleAddAllowance} className="bg-gray-50 p-3 rounded border border-gray-200 space-y-3">
                  <div className="text-xs font-semibold text-gray-700 uppercase">Thêm khoản phụ cấp trong kỳ</div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Nhân viên *</label>
                      <select
                        required
                        value={allowanceForm.employeeId}
                        onChange={(e) => setAllowanceForm({ ...allowanceForm, employeeId: e.target.value })}
                        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
                      >
                        <option value="">-- Chọn nhân viên --</option>
                        {employees.map((emp) => (
                          <option key={emp.id} value={emp.id}>
                            {emp.employee_code} - {emp.full_name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Số tiền (VNĐ) *</label>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        required
                        placeholder="VD: 500000"
                        value={allowanceForm.amount}
                        onChange={(e) => setAllowanceForm({ ...allowanceForm, amount: e.target.value })}
                        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 mb-1">Lý do phụ cấp *</label>
                      <input
                        type="text"
                        required
                        placeholder="VD: Phụ cấp xăng xe, thưởng chuyên cần..."
                        value={allowanceForm.reason}
                        onChange={(e) => setAllowanceForm({ ...allowanceForm, reason: e.target.value })}
                        className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={addAllowanceMut.isPending}
                      className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-1.5 rounded disabled:opacity-50"
                    >
                      {addAllowanceMut.isPending ? 'Đang lưu...' : 'Thêm phụ cấp'}
                    </button>
                  </div>
                </form>
              )}

              {allowError ? (
                <div className="p-3 bg-red-50 text-red-600 rounded text-sm">
                  Lỗi tải danh sách phụ cấp: {(allowError as any).message}
                </div>
              ) : allowLoading ? (
                <div className="p-4 text-sm text-gray-500">Đang tải danh sách phụ cấp...</div>
              ) : (
                <table className="w-full border-collapse border border-gray-200 text-left text-sm">
                  <thead>
                    <tr className="bg-gray-100 border-b border-gray-200">
                      <th className="p-2 border border-gray-200">Mã NV</th>
                      <th className="p-2 border border-gray-200">Họ và tên</th>
                      <th className="p-2 border border-gray-200 text-right">Số tiền (VNĐ)</th>
                      <th className="p-2 border border-gray-200">Lý do</th>
                      {isPeriodOpen && <th className="p-2 border border-gray-200 w-24 text-center">Thao tác</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {allowances.length === 0 ? (
                      <tr>
                        <td colSpan={isPeriodOpen ? 5 : 4} className="p-4 text-center text-gray-500">
                          Chưa có khoản phụ cấp nào trong kỳ lương này.
                        </td>
                      </tr>
                    ) : (
                      allowances.map((item) => {
                        const fallbackEmp = employees.find((e) => e.id === item.employee_id);
                        const empCode = item.employees?.employee_code ?? fallbackEmp?.employee_code ?? item.employee_id;
                        const empName = item.employees?.full_name ?? fallbackEmp?.full_name ?? '—';
                        const isDeletingThis =
                          deleteAllowanceMut.isPending && deleteAllowanceMut.variables === item.id;

                        return (
                          <tr key={item.id} className="border-b border-gray-200 hover:bg-gray-50">
                            <td className="p-2 border border-gray-200 font-mono text-xs">{empCode}</td>
                            <td className="p-2 border border-gray-200">{empName}</td>
                            <td className="p-2 border border-gray-200 text-right font-medium">
                              {vndFormatter.format(item.amount)} ₫
                            </td>
                            <td className="p-2 border border-gray-200">{item.reason}</td>
                            {isPeriodOpen && (
                              <td className="p-2 border border-gray-200 text-center">
                                <button
                                  type="button"
                                  disabled={deleteAllowanceMut.isPending}
                                  onClick={() =>
                                    window.confirm('Xác nhận xóa khoản phụ cấp này?') &&
                                    deleteAllowanceMut.mutate(item.id)
                                  }
                                  className="text-red-600 hover:underline text-xs disabled:opacity-50"
                                >
                                  {isDeletingThis ? 'Đang xóa...' : 'Xóa'}
                                </button>
                              </td>
                            )}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
