import { useState, useEffect, useMemo } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { Database } from '@timekeeping/shared/database.types';
import { useAuth } from '../../../lib/auth-context';
import { supabase } from '../../../lib/supabase';

export const Route = createFileRoute('/admin/payroll/view')({
  component: ApprovedPayrollViewPage,
});

type ApprovedPayrollPeriod = Pick<
  Database['public']['Tables']['payroll_periods']['Row'],
  'id' | 'year' | 'month' | 'status' | 'approved_at'
>;
type PayrollRow = Database['public']['Tables']['payroll']['Row'];
type EmployeeProfile = Pick<
  Database['public']['Tables']['employees']['Row'],
  'id' | 'employee_code' | 'full_name' | 'is_active'
>;
type BranchRow = Pick<
  Database['public']['Tables']['branches']['Row'],
  'id' | 'code' | 'name'
>;

const vndFormatter = new Intl.NumberFormat('vi-VN');

function formatVND(amount: number): string {
  return `${vndFormatter.format(Math.round(Number(amount) || 0))} ₫`;
}

function formatMinutesAndHours(mins: number): { minText: string; hourText: string } {
  const safeMins = Number(mins) || 0;
  const hours = (safeMins / 60).toFixed(2);
  return {
    minText: `${vndFormatter.format(safeMins)} phút`,
    hourText: `${hours} giờ`,
  };
}

// Tính mốc thời gian đầu tháng và đầu tháng kế tiếp theo múi giờ Việt Nam (Asia/Ho_Chi_Minh, +07:00)
function getVietnamMonthBounds(year: number, month: number): { startIso: string; endIso: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const startIso = `${year}-${pad(month)}-01T00:00:00+07:00`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endIso = `${nextYear}-${pad(nextMonth)}-01T00:00:00+07:00`;
  return { startIso, endIso };
}

function ApprovedPayrollViewPage() {
  const { user, role } = useAuth();
  const isAdmin = role === 'admin';

  const [selectedPeriodId, setSelectedPeriodId] = useState<string>('');
  const [selectedBranchId, setSelectedBranchId] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);

  // 1. Chỉ truy vấn danh sách các kỳ lương đã duyệt (status = 'approved'), sắp xếp mới nhất trước
  const approvedPeriodsKey = ['approved-payroll-periods', user?.id, role];
  const {
    data: approvedPeriods = [],
    isLoading: periodsLoading,
    error: periodsError,
  } = useQuery({
    queryKey: approvedPeriodsKey,
    enabled: !!user && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payroll_periods')
        .select('id,year,month,status,approved_at')
        .eq('status', 'approved')
        .order('year', { ascending: false })
        .order('month', { ascending: false });
      if (error) throw error;
      return (data ?? []) as ApprovedPayrollPeriod[];
    },
  });

  // Mặc định chọn kỳ lương đã duyệt mới nhất
  useEffect(() => {
    const firstPeriod = approvedPeriods[0];
    if (!selectedPeriodId && firstPeriod) {
      setSelectedPeriodId(firstPeriod.id);
    }
  }, [approvedPeriods, selectedPeriodId]);

  const selectedPeriod = useMemo(
    () => approvedPeriods.find((p) => p.id === selectedPeriodId) ?? null,
    [approvedPeriods, selectedPeriodId]
  );

  // 2. Truy vấn danh mục nhân viên và chi nhánh
  const employeesKey = ['employees-payroll-view', user?.id, role];
  const {
    data: employees = [],
    isLoading: employeesLoading,
    error: employeesError,
  } = useQuery({
    queryKey: employeesKey,
    enabled: !!user && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select('id,employee_code,full_name,is_active')
        .order('employee_code', { ascending: true });
      if (error) throw error;
      return (data ?? []) as EmployeeProfile[];
    },
  });

  const employeeMap = useMemo(() => {
    const map = new Map<string, EmployeeProfile>();
    for (const emp of employees) {
      map.set(emp.id, emp);
    }
    return map;
  }, [employees]);

  const branchesKey = ['branches-payroll-view', user?.id, role];
  const {
    data: branches = [],
    isLoading: branchesLoading,
    error: branchesError,
  } = useQuery({
    queryKey: branchesKey,
    enabled: !!user && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('branches')
        .select('id,code,name')
        .order('code', { ascending: true });
      if (error) throw error;
      return (data ?? []) as BranchRow[];
    },
  });

  // 3. Truy vấn dữ liệu bảng lương đã chốt (snapshot cố định từ bảng payroll) của kỳ được chọn
  // Tuyệt đối không tự tính lại công thức lương trên trình duyệt
  const payrollRowsKey = ['approved-payroll-rows', user?.id, selectedPeriodId];
  const {
    data: payrollRows = [],
    isLoading: payrollLoading,
    error: payrollError,
  } = useQuery({
    queryKey: payrollRowsKey,
    enabled: !!user && isAdmin && !!selectedPeriodId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('payroll')
        .select(
          'id,period_id,employee_id,hourly_rate_snapshot,fixed_allowance_snapshot,minutes_regular_day,minutes_regular_night,minutes_ot_day,minutes_ot_night,minutes_holiday_day,minutes_holiday_night,total_allowance,total_salary,calculated_at'
        )
        .eq('period_id', selectedPeriodId);
      if (error) throw error;
      return (data ?? []) as PayrollRow[];
    },
  });

  // 4. Lọc theo chi nhánh dựa trên dữ liệu chấm công thực tế (chưa bị hủy voided_at IS NULL) trong tháng theo giờ VN
  // Vì bảng payroll lưu tổng lương cấp nhân viên (không tách theo chi nhánh), nhân viên có ít nhất 1 lượt chấm công hợp lệ tại chi nhánh sẽ được hiển thị toàn bộ bảng lương tháng đó
  const branchFilterKey = [
    'approved-payroll-branch-punches',
    user?.id,
    selectedPeriodId,
    selectedBranchId,
  ];
  const {
    data: branchEmployeeIds = [],
    isLoading: branchPunchesLoading,
    error: branchPunchesError,
  } = useQuery({
    queryKey: branchFilterKey,
    enabled:
      !!user &&
      isAdmin &&
      !!selectedPeriod &&
      selectedBranchId !== 'ALL',
    queryFn: async () => {
      if (!selectedPeriod) return [];
      const { startIso, endIso } = getVietnamMonthBounds(
        selectedPeriod.year,
        selectedPeriod.month
      );
      const { data, error } = await supabase
        .from('punches')
        .select('employee_id')
        .eq('branch_id', selectedBranchId)
        .is('voided_at', null)
        .gte('at', startIso)
        .lt('at', endIso);
      if (error) throw error;
      const uniqueIds = new Set<string>();
      for (const row of data ?? []) {
        if (row.employee_id) uniqueIds.add(row.employee_id);
      }
      return Array.from(uniqueIds);
    },
  });

  const branchEmployeeIdSet = useMemo(
    () => new Set<string>(branchEmployeeIds),
    [branchEmployeeIds]
  );

  // Kết hợp lọc chi nhánh, tìm kiếm mã/tên nhân viên và sắp xếp theo mã nhân viên
  const filteredRows = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    return payrollRows
      .filter((row) => {
        if (selectedBranchId !== 'ALL' && !branchEmployeeIdSet.has(row.employee_id)) {
          return false;
        }
        if (!keyword) return true;
        const emp = employeeMap.get(row.employee_id);
        const code = (emp?.employee_code ?? row.employee_id).toLowerCase();
        const name = (emp?.full_name ?? '').toLowerCase();
        return code.includes(keyword) || name.includes(keyword);
      })
      .sort((a, b) => {
        const codeA = employeeMap.get(a.employee_id)?.employee_code ?? a.employee_id;
        const codeB = employeeMap.get(b.employee_id)?.employee_code ?? b.employee_id;
        return codeA.localeCompare(codeB);
      });
  }, [payrollRows, selectedBranchId, branchEmployeeIdSet, searchTerm, employeeMap]);

  // Tự động đồng bộ nhân viên đang chọn để hiển thị Phiếu lương chi tiết (Payslip)
  useEffect(() => {
    const firstRow = filteredRows[0];
    if (!firstRow) {
      setSelectedEmployeeId(null);
      return;
    }
    const exists = filteredRows.some((r) => r.employee_id === selectedEmployeeId);
    if (!exists) {
      setSelectedEmployeeId(firstRow.employee_id);
    }
  }, [filteredRows, selectedEmployeeId]);

  const selectedPayrollRow = useMemo(
    () => filteredRows.find((r) => r.employee_id === selectedEmployeeId) ?? null,
    [filteredRows, selectedEmployeeId]
  );

  if (!isAdmin) {
    return <div className="p-4 text-red-600">Bạn không có quyền truy cập phân hệ này.</div>;
  }

  if (periodsLoading || employeesLoading || branchesLoading) {
    return (
      <div className="p-4 text-gray-600">
        Đang tải danh sách kỳ lương đã duyệt, hồ sơ nhân viên và chi nhánh...
      </div>
    );
  }

  const initError = periodsError || employeesError || branchesError;
  if (initError) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
        Lỗi tải dữ liệu hệ thống: {(initError as any).message}
      </div>
    );
  }

  if (approvedPeriods.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center space-y-2 shadow-sm">
        <h3 className="text-base font-bold text-gray-800">Chưa có kỳ lương nào được duyệt</h3>
        <p className="text-sm text-gray-600">
          Vui lòng kiểm tra và chốt kỳ lương tại mục{' '}
          <Link to="/admin/payroll/preview" className="text-blue-600 font-semibold hover:underline">
            Xem trước & Duyệt lương
          </Link>{' '}
          để xem bảng lương chính thức và phiếu lương chi tiết.
        </p>
      </div>
    );
  }

  const selectedBranchObj = branches.find((b) => b.id === selectedBranchId) ?? null;

  return (
    <div className="space-y-6">
      {/* Thanh công cụ lọc kỳ lương đã duyệt, lọc chi nhánh và tìm kiếm nhân viên */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="approved-period-select"
              className="block text-xs font-semibold text-gray-700 mb-1"
            >
              Kỳ lương đã duyệt
            </label>
            <select
              id="approved-period-select"
              value={selectedPeriodId}
              onChange={(e) => setSelectedPeriodId(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white font-medium text-gray-800"
            >
              {approvedPeriods.map((p) => (
                <option key={p.id} value={p.id}>
                  Tháng {String(p.month).padStart(2, '0')}/{p.year} (Đã duyệt)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="branch-filter-select"
              className="block text-xs font-semibold text-gray-700 mb-1"
            >
              Lọc theo chi nhánh chấm công
            </label>
            <select
              id="branch-filter-select"
              value={selectedBranchId}
              onChange={(e) => setSelectedBranchId(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white font-medium text-gray-800"
            >
              <option value="ALL">Tất cả chi nhánh (Toàn công ty)</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="employee-search-input"
              className="block text-xs font-semibold text-gray-700 mb-1"
            >
              Tìm kiếm nhân viên
            </label>
            <input
              id="employee-search-input"
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Nhập mã NV hoặc họ tên..."
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
            />
          </div>
        </div>

        {/* Thông tin thời điểm duyệt kỳ lương và ghi chú minh bạch về bộ lọc chi nhánh */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-3 border-t border-gray-100 text-xs text-gray-600">
          <div>
            {selectedPeriod && (
              <span>
                Trạng thái:{' '}
                <strong className="text-emerald-700">Đã chốt sổ chính thức</strong>
                {selectedPeriod.approved_at
                  ? ` vào lúc ${new Date(selectedPeriod.approved_at).toLocaleString('vi-VN', {
                      timeZone: 'Asia/Ho_Chi_Minh',
                    })}`
                  : ''}
              </span>
            )}
          </div>
          <div>
            Số nhân viên hiển thị:{' '}
            <span className="font-bold text-gray-900">{filteredRows.length}</span> /{' '}
            {payrollRows.length}
          </div>
        </div>

        <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900">
          <strong>Lưu ý về dữ liệu theo chi nhánh:</strong> Bảng lương đã duyệt được lưu trữ tổng hợp ở cấp độ từng nhân viên trên toàn công ty, không tách nhỏ số tiền lương theo từng chi nhánh. Khi chọn lọc một chi nhánh
          {selectedBranchObj ? ` (${selectedBranchObj.code} — ${selectedBranchObj.name})` : ''}, hệ thống hiển thị các nhân viên có ít nhất 1 lượt chấm công hợp lệ (chưa hủy) tại chi nhánh đó trong tháng (theo múi giờ Việt Nam) kèm <strong>toàn bộ tổng lương tháng</strong> của nhân viên đó. Nhân viên làm việc tại nhiều chi nhánh có thể xuất hiện ở kết quả lọc của từng chi nhánh liên quan.
        </div>
      </div>

      {/* Hiển thị lỗi nếu truy vấn bảng lương hoặc truy vấn lọc chấm công chi nhánh thất bại */}
      {payrollError ? (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          Lỗi tải dữ liệu bảng lương đã duyệt: {(payrollError as any).message}
        </div>
      ) : selectedBranchId !== 'ALL' && branchPunchesError ? (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          Lỗi khi lọc danh sách nhân viên chấm công theo chi nhánh:{' '}
          {(branchPunchesError as any).message}
        </div>
      ) : payrollLoading || (selectedBranchId !== 'ALL' && branchPunchesLoading) ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-sm text-gray-600">
          Đang tải bảng lương đã duyệt và dữ liệu liên quan...
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-sm text-gray-500">
          Không tìm thấy bản ghi bảng lương nào khớp với điều kiện lọc hiện tại.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
          {/* Cột trái (2/3): Bảng tổng hợp lương toàn công ty của kỳ đã duyệt */}
          <div className="xl:col-span-2 bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            <div className="p-4 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-gray-800">
                  Bảng lương chính thức — Tháng{' '}
                  {selectedPeriod ? String(selectedPeriod.month).padStart(2, '0') : ''}/
                  {selectedPeriod?.year}
                </h3>
                <p className="text-xs text-gray-500">
                  Chọn một nhân viên để xem Phiếu lương chi tiết (Payslip) bên cạnh.
                </p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="bg-gray-100 border-b border-gray-200 text-gray-700">
                    <th className="p-2.5 border-r border-gray-200">Nhân viên</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">Đơn giá giờ</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">Thường ngày</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">Thường đêm</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">TC ngày</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">TC đêm</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">Lễ ngày</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">Lễ đêm</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">PC cố định</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">PC tháng</th>
                    <th className="p-2.5 text-right bg-blue-50 text-blue-900">Tổng lương</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {filteredRows.map((row) => {
                    const emp = employeeMap.get(row.employee_id);
                    const empCode = emp?.employee_code ?? row.employee_id;
                    const empName = emp?.full_name ?? 'Nhân viên không xác định';
                    const isSelected = row.employee_id === selectedEmployeeId;

                    const regDay = formatMinutesAndHours(row.minutes_regular_day);
                    const regNight = formatMinutesAndHours(row.minutes_regular_night);
                    const otDay = formatMinutesAndHours(row.minutes_ot_day);
                    const otNight = formatMinutesAndHours(row.minutes_ot_night);
                    const holDay = formatMinutesAndHours(row.minutes_holiday_day);
                    const holNight = formatMinutesAndHours(row.minutes_holiday_night);

                    return (
                      <tr
                        key={row.id}
                        onClick={() => setSelectedEmployeeId(row.employee_id)}
                        className={`cursor-pointer align-top transition-colors ${
                          isSelected ? 'bg-blue-50/80 ring-1 ring-inset ring-blue-300' : 'hover:bg-gray-50'
                        }`}
                      >
                        <td className="p-2.5 border-r border-gray-200">
                          <button
                            type="button"
                            onClick={() => setSelectedEmployeeId(row.employee_id)}
                            aria-pressed={isSelected}
                            aria-label={`Xem phiếu lương của ${empCode} - ${empName}`}
                            className="w-full text-left rounded px-1 py-0.5 -mx-1 -my-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
                          >
                            <span className="block font-mono font-bold text-gray-900">{empCode}</span>
                            <span className="block text-gray-700 font-medium">{empName}</span>
                          </button>
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right font-medium text-gray-800 whitespace-nowrap">
                          {formatVND(row.hourly_rate_snapshot)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          <div className="font-medium text-gray-800">{regDay.minText}</div>
                          <div className="text-gray-500">{regDay.hourText}</div>
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          <div className="font-medium text-gray-800">{regNight.minText}</div>
                          <div className="text-gray-500">{regNight.hourText}</div>
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          <div className="font-medium text-gray-800">{otDay.minText}</div>
                          <div className="text-gray-500">{otDay.hourText}</div>
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          <div className="font-medium text-gray-800">{otNight.minText}</div>
                          <div className="text-gray-500">{otNight.hourText}</div>
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          <div className="font-medium text-gray-800">{holDay.minText}</div>
                          <div className="text-gray-500">{holDay.hourText}</div>
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          <div className="font-medium text-gray-800">{holNight.minText}</div>
                          <div className="text-gray-500">{holNight.hourText}</div>
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right font-medium text-gray-800 whitespace-nowrap">
                          {formatVND(row.fixed_allowance_snapshot)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right font-medium text-gray-800 whitespace-nowrap">
                          {formatVND(row.total_allowance)}
                        </td>
                        <td className="p-2.5 text-right font-bold text-blue-900 bg-blue-50/40 whitespace-nowrap text-sm">
                          {formatVND(row.total_salary)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Cột phải (1/3): Phiếu lương chi tiết (Payslip) của nhân viên đang chọn */}
          <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            <div className="p-4 bg-blue-600 text-white">
              <div className="text-xs uppercase tracking-wider font-semibold opacity-90">
                Phiếu lương nhân viên (Payslip)
              </div>
              <h4 className="text-lg font-bold mt-0.5">
                Kỳ lương Tháng{' '}
                {selectedPeriod ? String(selectedPeriod.month).padStart(2, '0') : ''}/
                {selectedPeriod?.year}
              </h4>
            </div>

            {!selectedPayrollRow ? (
              <div className="p-6 text-center text-sm text-gray-500">
                Chọn một nhân viên trong bảng để xem chi tiết phiếu lương.
              </div>
            ) : (
              <PayslipDetailPanel
                row={selectedPayrollRow}
                employee={employeeMap.get(selectedPayrollRow.employee_id)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Thành phần hiển thị chi tiết Phiếu lương từ dữ liệu snapshot đã lưu trong bảng payroll
function PayslipDetailPanel({
  row,
  employee,
}: {
  row: PayrollRow;
  employee?: EmployeeProfile;
}) {
  const empCode = employee?.employee_code ?? row.employee_id;
  const empName = employee?.full_name ?? 'Nhân viên không xác định';

  const minuteCategories = [
    { label: 'Công thường ban ngày (1.0x)', mins: row.minutes_regular_day },
    { label: 'Công thường ban đêm (1.3x)', mins: row.minutes_regular_night },
    { label: 'Tăng ca ban ngày (1.5x)', mins: row.minutes_ot_day },
    { label: 'Tăng ca ban đêm (1.8x)', mins: row.minutes_ot_night },
    { label: 'Làm ngày lễ ban ngày (2.0x)', mins: row.minutes_holiday_day },
    { label: 'Làm ngày lễ ban đêm (2.3x)', mins: row.minutes_holiday_night },
  ];

  return (
    <div className="p-5 space-y-5 text-sm">
      <div className="border-b border-gray-200 pb-3">
        <div className="text-xs text-gray-500">Nhân viên</div>
        <div className="text-base font-bold text-gray-900">{empName}</div>
        <div className="text-xs font-mono font-semibold text-gray-600 mt-0.5">
          Mã NV: {empCode}
        </div>
      </div>

      {/* Thông số mức lương & phụ cấp đã lưu snapshot */}
      <div className="space-y-2">
        <div className="text-xs font-bold uppercase text-gray-500 tracking-wide">
          Đơn giá & Phụ cấp (Snapshot khi chốt sổ)
        </div>
        <div className="bg-gray-50 rounded-md p-3 space-y-2 border border-gray-200 text-xs">
          <div className="flex justify-between">
            <span className="text-gray-600">Đơn giá lương theo giờ:</span>
            <span className="font-semibold text-gray-900">
              {formatVND(row.hourly_rate_snapshot)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Phụ cấp cố định:</span>
            <span className="font-semibold text-gray-900">
              {formatVND(row.fixed_allowance_snapshot)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Tổng phụ cấp tháng phát sinh:</span>
            <span className="font-semibold text-gray-900">
              {formatVND(row.total_allowance)}
            </span>
          </div>
        </div>
      </div>

      {/* Chi tiết 6 nhóm thời gian làm việc */}
      <div className="space-y-2">
        <div className="text-xs font-bold uppercase text-gray-500 tracking-wide">
          Chi tiết 6 nhóm thời gian công
        </div>
        <div className="divide-y divide-gray-100 border border-gray-200 rounded-md">
          {minuteCategories.map((cat) => {
            const formatted = formatMinutesAndHours(cat.mins);
            return (
              <div
                key={cat.label}
                className="p-2.5 flex items-center justify-between text-xs"
              >
                <span className="text-gray-700">{cat.label}</span>
                <div className="text-right">
                  <span className="font-semibold text-gray-900">{formatted.minText}</span>
                  <span className="text-gray-500 ml-1.5">({formatted.hourText})</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Tổng thực lĩnh đã lưu trong DB và thời điểm tính */}
      <div className="bg-blue-50 border border-blue-200 rounded-md p-4 space-y-1">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-bold uppercase text-blue-900">Tổng lương chốt sổ</span>
          <span className="text-lg font-extrabold text-blue-900">
            {formatVND(row.total_salary)}
          </span>
        </div>
        <div className="text-[11px] text-blue-800 pt-1 border-t border-blue-100">
          Thời điểm chốt dữ liệu:{' '}
          {new Date(row.calculated_at).toLocaleString('vi-VN', {
            timeZone: 'Asia/Ho_Chi_Minh',
          })}
        </div>
      </div>
    </div>
  );
}
