import React, { useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EMPLOYEE_CODE_REGEX } from '@timekeeping/shared/auth';
import type { Database } from '@timekeeping/shared/database.types';
import { apiFetch } from '../../lib/api';
import { useAuth } from '../../lib/auth-context';
import { supabase } from '../../lib/supabase';

// Route con chỉ trả về nội dung; bố cục và ranh giới xác thực do route cha /admin đảm nhiệm
export const Route = createFileRoute('/admin/employees')({ component: AdminEmployeesComponent });

type EmployeeRole = Database['public']['Enums']['employee_role'];
// Vai trò được phép gán trực tiếp từ UI quản trị (tạo mới hoặc đổi qua lại giữa employee <-> manager)
type AssignableEmployeeRole = Exclude<EmployeeRole, 'admin'>;
type EmployeeRow = Pick<
  Database['public']['Tables']['employees']['Row'],
  | 'id'
  | 'employee_code'
  | 'full_name'
  | 'role'
  | 'is_active'
  | 'hourly_rate'
  | 'fixed_allowance'
  | 'home_branch_id'
>;
type DirectoryEmployeeRow =
  Database['public']['Functions']['employee_directory']['Returns'][number];
type BranchOption = Pick<Database['public']['Tables']['branches']['Row'], 'id' | 'code' | 'name'>;

const PAGE_SIZE = 25;
const MAX_COMPENSATION_AMOUNT = 1_000_000_000;
const PIN_REGEX = /^\d{4,6}$/;

const ROLE_LABELS: Record<EmployeeRole, string> = {
  employee: 'Nhân viên',
  manager: 'Quản lý',
  admin: 'Quản trị viên',
};

function isEmployeeRole(value: string): value is EmployeeRole {
  return value === 'employee' || value === 'manager' || value === 'admin';
}

function isAssignableEmployeeRole(value: string): value is AssignableEmployeeRole {
  return value === 'employee' || value === 'manager';
}

function getRoleLabel(role: string): string {
  return isEmployeeRole(role) ? ROLE_LABELS[role] : role;
}

const currencyFormatter = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0,
});

function validateCompensation(hourlyRateRaw: string, fixedAllowanceRaw: string): {
  ok: true;
  hourlyRate: number;
  fixedAllowance: number;
} | {
  ok: false;
  error: string;
} {
  if (hourlyRateRaw.trim() === '' || fixedAllowanceRaw.trim() === '') {
    return { ok: false, error: 'Vui lòng nhập đầy đủ lương giờ và phụ cấp cố định.' };
  }
  const hourlyRate = Number(hourlyRateRaw);
  const fixedAllowance = Number(fixedAllowanceRaw);

  if (!Number.isFinite(hourlyRate) || hourlyRate < 0 || hourlyRate > MAX_COMPENSATION_AMOUNT) {
    return {
      ok: false,
      error: `Lương theo giờ phải là số hợp lệ từ 0 đến ${MAX_COMPENSATION_AMOUNT.toLocaleString('vi-VN')}.`,
    };
  }
  if (!Number.isFinite(fixedAllowance) || fixedAllowance < 0 || fixedAllowance > MAX_COMPENSATION_AMOUNT) {
    return {
      ok: false,
      error: `Phụ cấp cố định phải là số hợp lệ từ 0 đến ${MAX_COMPENSATION_AMOUNT.toLocaleString('vi-VN')}.`,
    };
  }

  return {
    ok: true,
    hourlyRate: Math.round(hourlyRate * 100) / 100,
    fixedAllowance: Math.round(fixedAllowance * 100) / 100,
  };
}

function AdminEmployeesComponent() {
  const { role, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = role === 'admin';
  const isManager = role === 'manager';

  // Bộ lọc & phân trang
  const [page, setPage] = useState<number>(1);
  const [searchInput, setSearchInput] = useState<string>('');
  const [roleFilter, setRoleFilter] = useState<'all' | EmployeeRole>('all');
  const [branchFilter, setBranchFilter] = useState<string>('all');

  // Thông báo trạng thái thao tác (không bao giờ chứa mật khẩu hoặc mã PIN)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Trạng thái modal Tạo nhân viên mới (chỉ cho phép tạo employee hoặc manager)
  const [isCreateOpen, setIsCreateOpen] = useState<boolean>(false);
  const [createForm, setCreateForm] = useState<{
    employeeCode: string;
    fullName: string;
    role: AssignableEmployeeRole;
    homeBranchId: string;
    hourlyRate: string;
    fixedAllowance: string;
    password: string;
    pin: string;
  }>({
    employeeCode: '',
    fullName: '',
    role: 'employee',
    homeBranchId: '',
    hourlyRate: '0',
    fixedAllowance: '0',
    password: '',
    pin: '',
  });
  const [createFormError, setCreateFormError] = useState<string | null>(null);
  const [isLoadingNextCode, setIsLoadingNextCode] = useState<boolean>(false);
  const [nextCodeError, setNextCodeError] = useState<string | null>(null);

  // Quản lý phiên mở modal tạo mới và trạng thái gõ tay mã nhân viên:
  // - Đảm bảo kết quả next-code trả về muộn không ghi đè nếu Admin đã gõ tay vào ô mã nhân viên.
  // - Bỏ qua kết quả nếu modal đã đóng, component unmount hoặc đã chuyển sang phiên mở/lượt gọi khác.
  const createModalSessionRef = useRef<number>(0);
  const nextCodeRequestIdRef = useRef<number>(0);
  const employeeCodeEditedByUserRef = useRef<boolean>(false);

  useEffect(() => {
    return () => {
      // Vô hiệu hóa mọi request gợi ý mã đang chờ khi component unmount
      createModalSessionRef.current += 1;
      nextCodeRequestIdRef.current += 1;
    };
  }, []);

  // Trạng thái modal Sửa nhân viên (vai trò employee/manager, chi nhánh chính, lương & phụ cấp)
  const [editingEmployee, setEditingEmployee] = useState<EmployeeRow | null>(null);
  const [editRole, setEditRole] = useState<AssignableEmployeeRole>('employee');
  const [editHourlyRate, setEditHourlyRate] = useState<string>('');
  const [editFixedAllowance, setEditFixedAllowance] = useState<string>('');
  const [editHomeBranchId, setEditHomeBranchId] = useState<string>('');
  const [editFormError, setEditFormError] = useState<string | null>(null);

  // Trạng thái modal Đặt lại mật khẩu
  const [passwordTarget, setPasswordTarget] = useState<EmployeeRow | null>(null);
  const [newPassword, setNewPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [confirmPasswordResetChecked, setConfirmPasswordResetChecked] = useState<boolean>(false);
  const [passwordFormError, setPasswordFormError] = useState<string | null>(null);

  // Trạng thái modal Đặt lại mã PIN
  const [pinTarget, setPinTarget] = useState<EmployeeRow | null>(null);
  const [newPin, setNewPin] = useState<string>('');
  const [confirmPin, setConfirmPin] = useState<string>('');
  const [confirmPinResetChecked, setConfirmPinResetChecked] = useState<boolean>(false);
  const [pinFormError, setPinFormError] = useState<string | null>(null);

  // Bảo mật: Lưu tạm thông tin nhạy cảm (password/PIN) trong ref ngắn hạn và xóa ngay khi gửi,
  // tuyệt đối không truyền vào variables của React Query để tránh lưu vết trong MutationCache.
  const transientSecretRef = useRef<{
    createPassword: string;
    createPin: string;
    resetPassword: string;
    resetPin: string;
  }>({
    createPassword: '',
    createPin: '',
    resetPassword: '',
    resetPin: '',
  });

  // Danh sách chi nhánh phục vụ bộ lọc và phân công chi nhánh chính của Admin
  const branchesQuery = useQuery({
    queryKey: ['admin-employees-branches'],
    enabled: isAdmin,
    queryFn: async (): Promise<BranchOption[]> => {
      const { data, error } = await supabase
        .from('branches')
        .select('id, code, name')
        .order('code', { ascending: true });

      if (error) {
        throw new Error(error.message);
      }
      return data ?? [];
    },
  });

  // Truy vấn danh sách nhân sự phân trang 25 bản ghi/trang.
  // Bảo mật: Chỉ thực thi cho Admin; tuyệt đối không truy vấn bảng employee_pins hoặc gọi employee_directory().
  const employeesQuery = useQuery({
    queryKey: ['admin-employees', { page, search: searchInput.trim(), roleFilter, branchFilter }],
    enabled: isAdmin,
    queryFn: async (): Promise<{ items: EmployeeRow[]; total: number }> => {
      let query = supabase
        .from('employees')
        .select(
          'id, employee_code, full_name, role, is_active, hourly_rate, fixed_allowance, home_branch_id',
          {
            count: 'exact',
          }
        );

      // Nghiệp vụ lọc chi nhánh của Admin: lọc trực tiếp theo chi nhánh chính (home_branch_id)
      // thay vì truy vấn lịch sử shifts/punches. Hỗ trợ lọc nhân sự chưa phân công chi nhánh.
      if (branchFilter === 'unassigned') {
        query = query.is('home_branch_id', null);
      } else if (branchFilter !== 'all') {
        query = query.eq('home_branch_id', branchFilter);
      }

      if (roleFilter !== 'all') {
        query = query.eq('role', roleFilter);
      }

      // Làm sạch chuỗi tìm kiếm để tránh làm hỏng cú pháp bộ lọc .or() của PostgREST
      const safeSearch = searchInput.trim().replace(/[%_(),]/g, '');
      if (safeSearch.length > 0) {
        query = query.or(`full_name.ilike.%${safeSearch}%,employee_code.ilike.%${safeSearch}%`);
      }

      const from = (page - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      const { data, error, count } = await query
        .order('employee_code', { ascending: true })
        .range(from, to);

      if (error) {
        throw new Error(error.message);
      }

      return {
        items: data ?? [],
        total: count ?? 0,
      };
    },
  });

  // Truy vấn các chi nhánh được phân công cho Manager thông qua bảng manager_branches (RLS: manager_id = auth.uid())
  const managerBranchesQuery = useQuery({
    queryKey: ['manager-employees-branches'],
    enabled: isManager,
    queryFn: async (): Promise<BranchOption[]> => {
      const { data: mbRows, error: mbError } = await supabase
        .from('manager_branches')
        .select('branch_id');

      if (mbError) {
        throw new Error(mbError.message);
      }

      const branchIds = Array.from(
        new Set((mbRows ?? []).map((row) => row.branch_id).filter(Boolean))
      );

      if (branchIds.length === 0) {
        return [];
      }

      const { data: branchesData, error: branchesError } = await supabase
        .from('branches')
        .select('id, code, name')
        .in('id', branchIds)
        .order('code', { ascending: true });

      if (branchesError) {
        throw new Error(branchesError.message);
      }

      return branchesData ?? [];
    },
  });

  const assignedBranches = managerBranchesQuery.data ?? [];
  const assignedBranchIds = assignedBranches.map((b) => b.id);

  // Danh bạ nhân sự chỉ đọc cho Manager qua hàm SECURITY DEFINER public.employee_directory() đã giới hạn phạm vi chi nhánh ở tầng DB.
  // Bảo mật: Tuyệt đối không trả về hoặc hiển thị hourly_rate, fixed_allowance, mã PIN hay mật khẩu.
  const managerEmployeesQuery = useQuery({
    queryKey: [
      'manager-employees-directory',
      {
        page,
        search: searchInput.trim(),
        roleFilter,
        branchFilter,
        assignedBranchIds,
      },
    ],
    enabled: isManager && !managerBranchesQuery.isLoading && assignedBranchIds.length > 0,
    queryFn: async (): Promise<{ items: DirectoryEmployeeRow[]; total: number }> => {
      let branchEmployeeIdSet: Set<string> | null = null;

      // Khi lọc theo một chi nhánh được giao, lấy tập employee_id từ shifts và punches của chi nhánh đó (RLS là lớp bảo vệ bổ sung)
      if (branchFilter !== 'all') {
        if (!assignedBranchIds.includes(branchFilter)) {
          return { items: [], total: 0 };
        }

        const [shiftsRes, punchesRes] = await Promise.all([
          supabase.from('shifts').select('employee_id').eq('branch_id', branchFilter),
          supabase.from('punches').select('employee_id').eq('branch_id', branchFilter),
        ]);

        if (shiftsRes.error) {
          throw new Error(shiftsRes.error.message);
        }
        if (punchesRes.error) {
          throw new Error(punchesRes.error.message);
        }

        branchEmployeeIdSet = new Set<string>();
        for (const row of shiftsRes.data ?? []) {
          if (row.employee_id) branchEmployeeIdSet.add(row.employee_id);
        }
        for (const row of punchesRes.data ?? []) {
          if (row.employee_id) branchEmployeeIdSet.add(row.employee_id);
        }

        if (branchEmployeeIdSet.size === 0) {
          return { items: [], total: 0 };
        }
      }

      const { data: directoryRows, error: directoryError } =
        await supabase.rpc('employee_directory');

      if (directoryError) {
        throw new Error(directoryError.message);
      }

      const normalizedSearch = searchInput.trim().toLowerCase();

      const filtered = (directoryRows ?? []).filter((emp) => {
        if (branchEmployeeIdSet !== null && !branchEmployeeIdSet.has(emp.id)) {
          return false;
        }
        if (roleFilter !== 'all' && emp.role !== roleFilter) {
          return false;
        }
        if (normalizedSearch.length > 0) {
          const codeMatch = (emp.employee_code ?? '').toLowerCase().includes(normalizedSearch);
          const nameMatch = (emp.full_name ?? '').toLowerCase().includes(normalizedSearch);
          if (!codeMatch && !nameMatch) {
            return false;
          }
        }
        return true;
      });

      const total = filtered.length;
      const from = (page - 1) * PAGE_SIZE;
      const items = filtered.slice(from, from + PAGE_SIZE);

      return { items, total };
    },
  });

  // Gọi API lấy mã nhân viên gợi ý tiếp theo (GET /api/employees/next-code).
  // Tuyệt đối không dùng useEffect để ghi đè form và không ghi đè nếu Admin đã tự nhập mã.
  const fetchNextEmployeeCode = async () => {
    const modalSessionId = createModalSessionRef.current;
    const requestId = ++nextCodeRequestIdRef.current;
    setIsLoadingNextCode(true);
    setNextCodeError(null);

    try {
      const res = await apiFetch<{ employeeCode?: string }>('/api/employees/next-code', {
        method: 'GET',
      });

      if (
        modalSessionId !== createModalSessionRef.current ||
        requestId !== nextCodeRequestIdRef.current
      ) {
        return;
      }

      const suggestedCode = typeof res?.employeeCode === 'string' ? res.employeeCode.trim() : '';
      if (!EMPLOYEE_CODE_REGEX.test(suggestedCode)) {
        setNextCodeError(
          'Không nhận được mã nhân viên gợi ý hợp lệ. Bạn có thể tự nhập mã gồm 4–6 chữ số.'
        );
        return;
      }

      if (!employeeCodeEditedByUserRef.current) {
        setCreateForm((prev) => ({ ...prev, employeeCode: suggestedCode }));
      }
    } catch (err) {
      if (
        modalSessionId !== createModalSessionRef.current ||
        requestId !== nextCodeRequestIdRef.current
      ) {
        return;
      }

      const errorCode = err instanceof Error ? err.message : '';
      if (errorCode === 'EMPLOYEE_CODE_EXHAUSTED') {
        setNextCodeError(
          'Kho mã nhân viên tự động (1000–999999) đã cạn, không còn mã trống để cấp mới.'
        );
      } else {
        setNextCodeError(
          'Không thể lấy mã nhân viên gợi ý. Vui lòng bấm "Lấy lại gợi ý" hoặc tự nhập mã 4–6 chữ số.'
        );
      }
    } finally {
      if (
        modalSessionId === createModalSessionRef.current &&
        requestId === nextCodeRequestIdRef.current
      ) {
        setIsLoadingNextCode(false);
      }
    }
  };

  // Mutation: Tạo nhân viên mới qua Worker API POST /api/employees (chỉ Admin)
  // Không gửi trường email lên server; email đăng nhập nội bộ được tổng hợp tự động từ employeeCode ở tầng backend.
  const createEmployeeMutation = useMutation({
    mutationFn: async (payload: {
      fullName: string;
      role: AssignableEmployeeRole;
      employeeCode: string;
      hourlyRate: number;
      fixedAllowance: number;
      homeBranchId: string | null;
    }) => {
      if (!isAdmin) {
        throw new Error('Chỉ Quản trị viên (Admin) mới có quyền tạo nhân viên.');
      }
      if (!isAssignableEmployeeRole(payload.role)) {
        throw new Error(
          'Chỉ được phép tạo mới hồ sơ với vai trò Nhân viên (employee) hoặc Quản lý (manager).'
        );
      }
      const password = transientSecretRef.current.createPassword;
      const pin = transientSecretRef.current.createPin;
      transientSecretRef.current.createPassword = '';
      transientSecretRef.current.createPin = '';

      const res = await apiFetch<{ ok: boolean; employeeId?: string; error?: string }>('/api/employees', {
        method: 'POST',
        body: JSON.stringify({
          password,
          fullName: payload.fullName,
          role: payload.role,
          employeeCode: payload.employeeCode,
          hourlyRate: payload.hourlyRate,
          fixedAllowance: payload.fixedAllowance,
          homeBranchId: payload.homeBranchId,
          pin,
        }),
      });

      if (!res?.ok) {
        throw new Error(res?.error || 'Không thể tạo nhân viên mới.');
      }

      return { employeeCode: payload.employeeCode, fullName: payload.fullName };
    },
    onSuccess: (result) => {
      createModalSessionRef.current += 1;
      nextCodeRequestIdRef.current += 1;
      employeeCodeEditedByUserRef.current = false;
      setIsLoadingNextCode(false);
      setNextCodeError(null);
      setIsCreateOpen(false);
      setCreateForm({
        employeeCode: '',
        fullName: '',
        role: 'employee',
        homeBranchId: '',
        hourlyRate: '0',
        fixedAllowance: '0',
        password: '',
        pin: '',
      });
      setCreateFormError(null);
      setFeedback({
        type: 'success',
        message: `Đã tạo nhân viên ${result.fullName} (${result.employeeCode}) thành công.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['admin-employees'] });
      void queryClient.invalidateQueries({ queryKey: ['manager-employees-directory'] });
    },
    onError: (err: Error) => {
      // Khi trùng mã nhân viên (409 EMPLOYEE_CODE_CONFLICT): giữ nguyên các trường thông tin đã nhập,
      // tự động lấy gợi ý mã mới và yêu cầu Admin nhập lại mật khẩu/PIN (không tự retry).
      if (err.message === 'EMPLOYEE_CODE_CONFLICT') {
        setCreateFormError(
          'Mã nhân viên này vừa được sử dụng hoặc đã tồn tại. Hệ thống đang lấy mã gợi ý mới; vui lòng kiểm tra mã nhân viên và nhập lại mật khẩu cùng mã PIN để tiếp tục.'
        );
        employeeCodeEditedByUserRef.current = false;
        void fetchNextEmployeeCode();
        return;
      }
      if (err.message === 'EMPLOYEE_CODE_EXHAUSTED') {
        setCreateFormError(
          'Kho mã nhân viên (1000–999999) đã cạn, không thể cấp thêm mã nhân viên mới.'
        );
        return;
      }
      setCreateFormError(err.message || 'Đã xảy ra lỗi khi tạo nhân viên.');
    },
  });

  // Mutation: Cập nhật thông tin nhân viên (role, home_branch_id, hourly_rate, fixed_allowance)
  // trực tiếp trên bảng employees qua Admin RLS. Bảng employees.role là nguồn chuẩn phân quyền
  // nên không cập nhật Auth app_metadata.
  const updateCompensationMutation = useMutation({
    mutationFn: async (payload: {
      employeeId: string;
      employeeCode: string;
      fullName: string;
      isTargetAdmin: boolean;
      role?: AssignableEmployeeRole;
      hourlyRate: number;
      fixedAllowance: number;
      homeBranchId: string | null;
    }) => {
      if (!isAdmin) {
        throw new Error(
          'Chỉ Quản trị viên (Admin) mới có quyền cập nhật thông tin nhân viên.'
        );
      }

      // Khởi tạo dữ liệu cập nhật lương, phụ cấp và chi nhánh chính đúng theo dữ liệu form.
      // Nếu hồ sơ đích đang là admin: chỉ cho phép sửa chi nhánh/lương, tuyệt đối KHÔNG gửi role mới
      // để ngăn promote/demote admin từ giao diện (đồng bộ với chốt chặn trigger ở DB).
      const updatePayload: Database['public']['Tables']['employees']['Update'] = {
        hourly_rate: payload.hourlyRate,
        fixed_allowance: payload.fixedAllowance,
        home_branch_id: payload.homeBranchId,
        updated_at: new Date().toISOString(),
      };

      if (!payload.isTargetAdmin) {
        if (!payload.role || !isAssignableEmployeeRole(payload.role)) {
          throw new Error(
            'Vai trò cập nhật không hợp lệ. Chỉ cho phép Nhân viên (employee) hoặc Quản lý (manager).'
          );
        }
        updatePayload.role = payload.role;
      }

      const { data, error } = await supabase
        .from('employees')
        .update(updatePayload)
        .eq('id', payload.employeeId)
        .select('id')
        .single();

      if (error) {
        throw new Error(error.message || 'Không thể cập nhật thông tin nhân viên.');
      }
      if (!data) {
        throw new Error('Không tìm thấy hồ sơ nhân viên hoặc không có quyền cập nhật.');
      }

      return payload;
    },
    onSuccess: (result) => {
      setEditingEmployee(null);
      setEditRole('employee');
      setEditHourlyRate('');
      setEditFixedAllowance('');
      setEditHomeBranchId('');
      setEditFormError(null);
      setFeedback({
        type: 'success',
        message: `Đã cập nhật thông tin nhân viên cho ${result.fullName} (${result.employeeCode}).`,
      });
      void queryClient.invalidateQueries({ queryKey: ['admin-employees'] });
      void queryClient.invalidateQueries({ queryKey: ['manager-employees-directory'] });
    },
    onError: (err: Error) => {
      setEditFormError(err.message || 'Cập nhật thông tin nhân viên thất bại.');
    },
  });

  // Mutation: Đặt lại mật khẩu qua Worker API POST /api/employees/:id/reset-password
  const resetPasswordMutation = useMutation({
    mutationFn: async (payload: { employeeId: string; employeeCode: string; fullName: string }) => {
      if (!isAdmin) {
        throw new Error('Chỉ Quản trị viên (Admin) mới có quyền đặt lại mật khẩu.');
      }
      const password = transientSecretRef.current.resetPassword;
      transientSecretRef.current.resetPassword = '';

      const res = await apiFetch<{ ok: boolean; error?: string }>(
        `/api/employees/${encodeURIComponent(payload.employeeId)}/reset-password`,
        {
          method: 'POST',
          body: JSON.stringify({ password }),
        }
      );

      if (!res?.ok) {
        throw new Error(res?.error || 'Đặt lại mật khẩu thất bại.');
      }

      return payload;
    },
    onSuccess: (result) => {
      setPasswordTarget(null);
      setNewPassword('');
      setConfirmPassword('');
      setConfirmPasswordResetChecked(false);
      setPasswordFormError(null);
      setFeedback({
        type: 'success',
        message: `Đã đặt lại mật khẩu đăng nhập cho nhân viên ${result.fullName} (${result.employeeCode}).`,
      });
      void queryClient.invalidateQueries({ queryKey: ['admin-employees'] });
    },
    onError: (err: Error) => {
      setPasswordFormError(err.message || 'Đặt lại mật khẩu thất bại.');
    },
  });

  // Mutation: Đặt lại mã PIN kiosk qua RPC reset_pin và kiểm tra JSON trả về { ok: true }
  const resetPinMutation = useMutation({
    mutationFn: async (payload: { employeeId: string; employeeCode: string; fullName: string }) => {
      if (!isAdmin) {
        throw new Error('Chỉ Quản trị viên (Admin) mới có quyền đặt lại mã PIN.');
      }
      const pin = transientSecretRef.current.resetPin;
      transientSecretRef.current.resetPin = '';

      const { data, error } = await supabase.rpc('reset_pin', {
        p_employee_id: payload.employeeId,
        p_new_pin: pin,
      });

      if (error) {
        throw new Error(error.message);
      }

      const rpcResult =
        data && typeof data === 'object' && !Array.isArray(data)
          ? (data as { ok?: boolean; error?: string })
          : null;

      if (!rpcResult || rpcResult.ok !== true) {
        throw new Error(rpcResult?.error || 'Đặt lại mã PIN thất bại.');
      }

      return payload;
    },
    onSuccess: (result) => {
      setPinTarget(null);
      setNewPin('');
      setConfirmPin('');
      setConfirmPinResetChecked(false);
      setPinFormError(null);
      setFeedback({
        type: 'success',
        message: `Đã đặt lại mã PIN kiosk cho nhân viên ${result.fullName} (${result.employeeCode}).`,
      });
      void queryClient.invalidateQueries({ queryKey: ['admin-employees'] });
    },
    onError: (err: Error) => {
      setPinFormError(err.message || 'Đặt lại mã PIN thất bại.');
    },
  });

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setCreateFormError(null);

    const employeeCode = createForm.employeeCode.trim();
    const fullName = createForm.fullName.trim();
    const password = createForm.password;
    const pin = createForm.pin.trim();

    if (!EMPLOYEE_CODE_REGEX.test(employeeCode)) {
      setCreateFormError(
        'Mã nhân viên phải gồm 4–6 chữ số và không bắt đầu bằng chữ số 0 (ví dụ: 1001).'
      );
      return;
    }
    if (fullName.length < 2 || fullName.length > 100) {
      setCreateFormError('Họ và tên phải có từ 2 đến 100 ký tự.');
      return;
    }
    if (!isAssignableEmployeeRole(createForm.role)) {
      setCreateFormError(
        'Vai trò khởi tạo chỉ được phép là Nhân viên (employee) hoặc Quản lý (manager).'
      );
      return;
    }
    if (password.length < 8 || password.length > 128) {
      setCreateFormError('Mật khẩu khởi tạo phải có tối thiểu 8 ký tự.');
      return;
    }
    if (!PIN_REGEX.test(pin)) {
      setCreateFormError('Mã PIN kiosk phải gồm 4–6 chữ số.');
      return;
    }

    const compCheck = validateCompensation(createForm.hourlyRate, createForm.fixedAllowance);
    if (!compCheck.ok) {
      setCreateFormError(compCheck.error);
      return;
    }

    // Chi nhánh chính có thể để trống (null = Chưa phân công)
    const homeBranchId = createForm.homeBranchId.trim() || null;

    transientSecretRef.current.createPassword = password;
    transientSecretRef.current.createPin = pin;
    setCreateForm((prev) => ({ ...prev, password: '', pin: '' }));

    createEmployeeMutation.mutate({
      fullName,
      role: createForm.role,
      employeeCode,
      hourlyRate: compCheck.hourlyRate,
      fixedAllowance: compCheck.fixedAllowance,
      homeBranchId,
    });
  };

  const handleUpdateCompensationSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingEmployee) return;
    setEditFormError(null);

    const isTargetAdmin = editingEmployee.role === 'admin';

    // Kiểm tra hợp lệ vai trò khi sửa hồ sơ không phải admin (chỉ nhận employee | manager)
    if (!isTargetAdmin && !isAssignableEmployeeRole(editRole)) {
      setEditFormError(
        'Vai trò chỉ được phép chuyển đổi giữa Nhân viên (employee) và Quản lý (manager).'
      );
      return;
    }

    const compCheck = validateCompensation(editHourlyRate, editFixedAllowance);
    if (!compCheck.ok) {
      setEditFormError(compCheck.error);
      return;
    }

    // Cho phép gán chi nhánh chính hoặc bỏ trống về trạng thái Chưa phân công (null)
    const homeBranchId = editHomeBranchId.trim() || null;

    updateCompensationMutation.mutate({
      employeeId: editingEmployee.id,
      employeeCode: editingEmployee.employee_code,
      fullName: editingEmployee.full_name,
      isTargetAdmin,
      role: isTargetAdmin ? undefined : editRole,
      hourlyRate: compCheck.hourlyRate,
      fixedAllowance: compCheck.fixedAllowance,
      homeBranchId,
    });
  };

  const handleResetPasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordTarget) return;
    setPasswordFormError(null);

    if (newPassword.length < 8 || newPassword.length > 128) {
      setPasswordFormError('Mật khẩu mới phải có tối thiểu 8 ký tự.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordFormError('Mật khẩu xác nhận không khớp.');
      return;
    }
    if (!confirmPasswordResetChecked) {
      setPasswordFormError('Vui lòng đánh dấu xác nhận thao tác đặt lại mật khẩu.');
      return;
    }
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        `Xác nhận đặt lại mật khẩu cho nhân viên ${passwordTarget.full_name} (${passwordTarget.employee_code})?`
      )
    ) {
      return;
    }

    transientSecretRef.current.resetPassword = newPassword;
    setNewPassword('');
    setConfirmPassword('');

    resetPasswordMutation.mutate({
      employeeId: passwordTarget.id,
      employeeCode: passwordTarget.employee_code,
      fullName: passwordTarget.full_name,
    });
  };

  const handleResetPinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pinTarget) return;
    setPinFormError(null);

    const trimmedPin = newPin.trim();
    if (!PIN_REGEX.test(trimmedPin)) {
      setPinFormError('Mã PIN mới phải gồm 4–6 chữ số.');
      return;
    }
    if (trimmedPin !== confirmPin.trim()) {
      setPinFormError('Mã PIN xác nhận không khớp.');
      return;
    }
    if (!confirmPinResetChecked) {
      setPinFormError('Vui lòng đánh dấu xác nhận thao tác đặt lại mã PIN.');
      return;
    }
    if (
      typeof window !== 'undefined' &&
      !window.confirm(
        `Xác nhận đặt lại mã PIN kiosk cho nhân viên ${pinTarget.full_name} (${pinTarget.employee_code})?`
      )
    ) {
      return;
    }

    transientSecretRef.current.resetPin = trimmedPin;
    setNewPin('');
    setConfirmPin('');

    resetPinMutation.mutate({
      employeeId: pinTarget.id,
      employeeCode: pinTarget.employee_code,
      fullName: pinTarget.full_name,
    });
  };

  if (authLoading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-gray-600">Đang kiểm tra quyền truy cập...</p>
      </div>
    );
  }

  // Giao diện chỉ đọc dành cho Quản lý (Manager): sử dụng employee_directory() đã lọc phạm vi chi nhánh ở DB,
  // tuyệt đối không hiển thị hourly_rate, fixed_allowance và không cung cấp thao tác chỉnh sửa.
  if (!isAdmin) {
    if (!isManager) {
      return (
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 shadow-sm">
          <p className="text-sm font-medium text-red-700">
            Bạn không có quyền truy cập trang danh bạ nhân sự.
          </p>
        </div>
      );
    }

    const managerItems = managerEmployeesQuery.data?.items ?? [];
    const managerTotalCount = managerEmployeesQuery.data?.total ?? 0;
    const managerTotalPages = Math.max(1, Math.ceil(managerTotalCount / PAGE_SIZE));
    const managerStartItem = managerTotalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
    const managerEndItem = Math.min(page * PAGE_SIZE, managerTotalCount);
    const hasActiveFilters =
      searchInput.trim() !== '' || roleFilter !== 'all' || branchFilter !== 'all';

    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-bold text-gray-800">Danh bạ Nhân viên</h2>
            <p className="mt-1 text-sm text-gray-600">
              Chế độ chỉ đọc cho Quản lý trong phạm vi chi nhánh được phân công (không bao gồm thông tin lương và phụ cấp).
            </p>
          </div>
          <span className="inline-flex items-center self-start rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-800">
            Chế độ chỉ đọc (Manager)
          </span>
        </div>

        {managerBranchesQuery.isLoading ? (
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-600 shadow-sm">
            Đang tải danh sách chi nhánh được phân công...
          </div>
        ) : managerBranchesQuery.isError ? (
          <div className="rounded-lg border border-red-200 bg-white p-6 text-center shadow-sm">
            <p className="text-sm font-medium text-red-600">
              Không thể tải danh sách chi nhánh: {(managerBranchesQuery.error as Error)?.message}
            </p>
            <button
              type="button"
              onClick={() => void managerBranchesQuery.refetch()}
              className="mt-3 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
            >
              Thử lại
            </button>
          </div>
        ) : assignedBranches.length === 0 ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-6 shadow-sm">
            <h3 className="text-base font-semibold text-amber-900">
              Chưa có chi nhánh được phân công
            </h3>
            <p className="mt-2 text-sm text-amber-800">
              Tài khoản Quản lý của bạn hiện chưa được gán vào chi nhánh nào. Vui lòng liên hệ Quản trị viên (Admin) để được phân công chi nhánh trước khi tra cứu danh bạ nhân sự.
            </p>
          </div>
        ) : (
          <>
            {/* Bộ lọc tìm kiếm, vai trò và chi nhánh được giao cho Manager */}
            <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
                <div className="md:col-span-2">
                  <label
                    htmlFor="manager-employee-search"
                    className="block text-xs font-medium text-gray-700"
                  >
                    Tìm kiếm theo mã nhân viên hoặc họ tên
                  </label>
                  <input
                    id="manager-employee-search"
                    type="text"
                    value={searchInput}
                    onChange={(e) => {
                      setSearchInput(e.target.value);
                      setPage(1);
                    }}
                    placeholder="Nhập mã NV hoặc họ và tên..."
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label
                    htmlFor="manager-role-filter"
                    className="block text-xs font-medium text-gray-700"
                  >
                    Vai trò
                  </label>
                  <select
                    id="manager-role-filter"
                    value={roleFilter}
                    onChange={(e) => {
                      const val = e.target.value;
                      setRoleFilter(isEmployeeRole(val) ? val : 'all');
                      setPage(1);
                    }}
                    className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="all">Tất cả vai trò</option>
                    <option value="employee">Nhân viên (employee)</option>
                    <option value="manager">Quản lý (manager)</option>
                    <option value="admin">Quản trị viên (admin)</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="manager-branch-filter"
                    className="block text-xs font-medium text-gray-700"
                  >
                    Chi nhánh được giao (theo ca làm / chấm công)
                  </label>
                  <select
                    id="manager-branch-filter"
                    value={branchFilter}
                    onChange={(e) => {
                      setBranchFilter(e.target.value);
                      setPage(1);
                    }}
                    className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="all">Tất cả chi nhánh được giao</option>
                    {assignedBranches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.code} - {b.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {hasActiveFilters && (
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setSearchInput('');
                      setRoleFilter('all');
                      setBranchFilter('all');
                      setPage(1);
                    }}
                    className="text-xs font-medium text-blue-600 hover:text-blue-800"
                  >
                    Xóa bộ lọc
                  </button>
                </div>
              )}
            </div>

            {/* Bảng danh bạ nhân sự chỉ đọc (không có cột lương/phụ cấp và không có thao tác) */}
            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
              {managerEmployeesQuery.isLoading ? (
                <div className="p-8 text-center text-sm text-gray-600">
                  Đang tải danh bạ nhân viên...
                </div>
              ) : managerEmployeesQuery.isError ? (
                <div className="p-6 text-center">
                  <p className="text-sm font-medium text-red-600">
                    Không thể tải danh bạ nhân viên:{' '}
                    {(managerEmployeesQuery.error as Error)?.message}
                  </p>
                  <button
                    type="button"
                    onClick={() => void managerEmployeesQuery.refetch()}
                    className="mt-3 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
                  >
                    Thử lại
                  </button>
                </div>
              ) : managerItems.length === 0 ? (
                <div className="p-8 text-center text-sm text-gray-500">
                  {hasActiveFilters
                    ? 'Không tìm thấy nhân viên nào phù hợp với điều kiện lọc hiện tại.'
                    : 'Chưa có nhân viên nào phát sinh ca làm hoặc dữ liệu chấm công tại các chi nhánh được phân công.'}
                </div>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
                      <thead className="bg-gray-50 text-xs font-semibold uppercase text-gray-600">
                        <tr>
                          <th className="px-4 py-3">Mã NV</th>
                          <th className="px-4 py-3">Họ và tên</th>
                          <th className="px-4 py-3">Vai trò</th>
                          <th className="px-4 py-3">Trạng thái</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200 bg-white">
                        {managerItems.map((emp) => (
                          <tr key={emp.id} className="hover:bg-gray-50">
                            <td className="whitespace-nowrap px-4 py-3 font-mono text-xs font-semibold text-gray-900">
                              {emp.employee_code}
                            </td>
                            <td className="px-4 py-3 font-medium text-gray-900">{emp.full_name}</td>
                            <td className="whitespace-nowrap px-4 py-3">
                              <span className="inline-flex rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800">
                                {getRoleLabel(emp.role)}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-4 py-3">
                              {emp.is_active ? (
                                <span className="inline-flex rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                                  Đang hoạt động
                                </span>
                              ) : (
                                <span className="inline-flex rounded-full bg-gray-200 px-2.5 py-0.5 text-xs font-medium text-gray-700">
                                  Ngưng hoạt động
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Thanh phân trang 25 bản ghi / trang */}
                  <div className="flex flex-col items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-4 py-3 sm:flex-row">
                    <p className="text-xs text-gray-600">
                      Hiển thị <span className="font-semibold">{managerStartItem}</span>–
                      <span className="font-semibold">{managerEndItem}</span> trên tổng số{' '}
                      <span className="font-semibold">{managerTotalCount}</span> nhân viên (Trang{' '}
                      {page}/{managerTotalPages})
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={page <= 1 || managerEmployeesQuery.isFetching}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        className="rounded border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Trang trước
                      </button>
                      <button
                        type="button"
                        disabled={page >= managerTotalPages || managerEmployeesQuery.isFetching}
                        onClick={() => setPage((p) => Math.min(managerTotalPages, p + 1))}
                        className="rounded border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Trang sau
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  const employees = employeesQuery.data?.items ?? [];
  const totalCount = employeesQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const startItem = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endItem = Math.min(page * PAGE_SIZE, totalCount);

  // Bản đồ tra cứu nhanh thông tin chi nhánh theo ID để hiển thị Chi nhánh chính trong bảng Admin
  const branchMap = new Map((branchesQuery.data ?? []).map((b) => [b.id, b]));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-800">Quản lý Nhân viên</h2>
          <p className="mt-1 text-sm text-gray-600">
            Quản trị hồ sơ nhân sự, mức lương theo giờ, phụ cấp cố định và thông tin xác thực.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            createModalSessionRef.current += 1;
            employeeCodeEditedByUserRef.current = false;
            setCreateFormError(null);
            setNextCodeError(null);
            setIsCreateOpen(true);
            void fetchNextEmployeeCode();
          }}
          className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          + Thêm nhân viên
        </button>
      </div>

      {feedback && (
        <div
          className={`flex items-center justify-between rounded-lg border p-4 text-sm ${
            feedback.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="ml-4 text-xs font-semibold underline"
          >
            Đóng
          </button>
        </div>
      )}

      {/* Bộ lọc tìm kiếm, vai trò và chi nhánh */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="md:col-span-2">
            <label htmlFor="employee-search" className="block text-xs font-medium text-gray-700">
              Tìm kiếm theo mã nhân viên hoặc họ tên
            </label>
            <input
              id="employee-search"
              type="text"
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value);
                setPage(1);
              }}
              placeholder="Nhập mã NV hoặc họ và tên..."
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="role-filter" className="block text-xs font-medium text-gray-700">
              Vai trò
            </label>
            <select
              id="role-filter"
              value={roleFilter}
              onChange={(e) => {
                setRoleFilter(e.target.value as 'all' | EmployeeRole);
                setPage(1);
              }}
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="all">Tất cả vai trò</option>
              <option value="employee">Nhân viên (employee)</option>
              <option value="manager">Quản lý (manager)</option>
              <option value="admin">Quản trị viên (admin)</option>
            </select>
          </div>

          <div>
            <label htmlFor="branch-filter" className="block text-xs font-medium text-gray-700">
              Chi nhánh chính
            </label>
            <select
              id="branch-filter"
              value={branchFilter}
              onChange={(e) => {
                setBranchFilter(e.target.value);
                setPage(1);
              }}
              className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            >
              <option value="all">Tất cả chi nhánh</option>
              <option value="unassigned">Chưa phân công</option>
              {(branchesQuery.data ?? []).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} - {b.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {(searchInput.trim() !== '' || roleFilter !== 'all' || branchFilter !== 'all') && (
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={() => {
                setSearchInput('');
                setRoleFilter('all');
                setBranchFilter('all');
                setPage(1);
              }}
              className="text-xs font-medium text-blue-600 hover:text-blue-800"
            >
              Xóa bộ lọc
            </button>
          </div>
        )}
      </div>

      {/* Bảng dữ liệu nhân viên */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        {employeesQuery.isLoading ? (
          <div className="p-8 text-center text-sm text-gray-600">
            Đang tải danh sách nhân viên...
          </div>
        ) : employeesQuery.isError ? (
          <div className="p-6 text-center">
            <p className="text-sm font-medium text-red-600">
              Không thể tải danh sách nhân viên: {(employeesQuery.error as Error)?.message}
            </p>
            <button
              type="button"
              onClick={() => void employeesQuery.refetch()}
              className="mt-3 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
            >
              Thử lại
            </button>
          </div>
        ) : employees.length === 0 ? (
          <div className="p-8 text-center text-sm text-gray-500">
            Không tìm thấy nhân viên nào phù hợp với điều kiện lọc hiện tại.
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
                <thead className="bg-gray-50 text-xs font-semibold uppercase text-gray-600">
                  <tr>
                    <th className="px-4 py-3">Mã NV</th>
                    <th className="px-4 py-3">Họ và tên</th>
                    <th className="px-4 py-3">Vai trò</th>
                    <th className="px-4 py-3">Chi nhánh chính</th>
                    <th className="px-4 py-3">Trạng thái</th>
                    <th className="px-4 py-3 text-right">Lương theo giờ</th>
                    <th className="px-4 py-3 text-right">Phụ cấp cố định</th>
                    <th className="px-4 py-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {employees.map((emp) => {
                    const homeBranch = emp.home_branch_id
                      ? branchMap.get(emp.home_branch_id)
                      : null;

                    return (
                      <tr key={emp.id} className="hover:bg-gray-50">
                        <td className="whitespace-nowrap px-4 py-3 font-mono text-xs font-semibold text-gray-900">
                          {emp.employee_code}
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900">{emp.full_name}</td>
                        <td className="whitespace-nowrap px-4 py-3">
                          <span className="inline-flex rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800">
                            {ROLE_LABELS[emp.role] ?? emp.role}
                          </span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {emp.home_branch_id ? (
                            <span className="inline-flex rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-800">
                              {homeBranch
                                ? `${homeBranch.code} - ${homeBranch.name}`
                                : emp.home_branch_id}
                            </span>
                          ) : (
                            <span className="text-xs italic text-gray-400">Chưa phân công</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3">
                          {emp.is_active ? (
                            <span className="inline-flex rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800">
                              Đang hoạt động
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full bg-gray-200 px-2.5 py-0.5 text-xs font-medium text-gray-700">
                              Ngưng hoạt động
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-gray-900">
                          {currencyFormatter.format(Number(emp.hourly_rate ?? 0))}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-gray-900">
                          {currencyFormatter.format(Number(emp.fixed_allowance ?? 0))}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-right">
                          <div className="inline-flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setEditingEmployee(emp);
                                setEditRole(
                                  emp.role === 'manager' ? 'manager' : 'employee'
                                );
                                setEditHourlyRate(String(emp.hourly_rate ?? 0));
                                setEditFixedAllowance(String(emp.fixed_allowance ?? 0));
                                setEditHomeBranchId(emp.home_branch_id ?? '');
                                setEditFormError(null);
                              }}
                              className="rounded border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                            >
                              Sửa nhân viên
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setPasswordTarget(emp);
                                setNewPassword('');
                                setConfirmPassword('');
                                setConfirmPasswordResetChecked(false);
                                setPasswordFormError(null);
                              }}
                              className="rounded border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
                            >
                              Đặt lại mật khẩu
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setPinTarget(emp);
                                setNewPin('');
                                setConfirmPin('');
                                setConfirmPinResetChecked(false);
                                setPinFormError(null);
                              }}
                              className="rounded border border-purple-300 bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-800 hover:bg-purple-100"
                            >
                              Đặt lại PIN
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Thanh phân trang phía server (25 bản ghi / trang) */}
            <div className="flex flex-col items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-4 py-3 sm:flex-row">
              <p className="text-xs text-gray-600">
                Hiển thị <span className="font-semibold">{startItem}</span>–
                <span className="font-semibold">{endItem}</span> trên tổng số{' '}
                <span className="font-semibold">{totalCount}</span> nhân viên (Trang {page}/{totalPages})
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1 || employeesQuery.isFetching}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="rounded border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Trang trước
                </button>
                <button
                  type="button"
                  disabled={page >= totalPages || employeesQuery.isFetching}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="rounded border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Trang sau
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Modal tạo nhân viên mới */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900">Thêm nhân viên mới</h3>
            <p className="mt-1 text-xs text-gray-500">
              Tạo tài khoản đăng nhập, hồ sơ nhân sự và mã PIN chấm công kiosk.
            </p>

            {createFormError && (
              <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                {createFormError}
              </div>
            )}

            <form onSubmit={handleCreateSubmit} className="mt-4 space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label className="block text-xs font-medium text-gray-700">
                      Mã nhân viên (4–6 chữ số) *
                    </label>
                    <button
                      type="button"
                      disabled={isLoadingNextCode || createEmployeeMutation.isPending}
                      onClick={() => {
                        employeeCodeEditedByUserRef.current = false;
                        void fetchNextEmployeeCode();
                      }}
                      className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isLoadingNextCode ? 'Đang lấy gợi ý...' : 'Lấy lại gợi ý'}
                    </button>
                  </div>
                  <input
                    type="text"
                    required
                    inputMode="numeric"
                    pattern="[1-9][0-9]{3,5}"
                    maxLength={6}
                    value={createForm.employeeCode}
                    onChange={(e) => {
                      employeeCodeEditedByUserRef.current = true;
                      setCreateForm((f) => ({ ...f, employeeCode: e.target.value }));
                    }}
                    placeholder={isLoadingNextCode ? 'Đang lấy mã gợi ý...' : 'VD: 1001'}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
                  />
                  {isLoadingNextCode ? (
                    <p className="mt-1 text-xs text-gray-500">Đang lấy mã nhân viên gợi ý...</p>
                  ) : nextCodeError ? (
                    <p className="mt-1 text-xs text-amber-700">{nextCodeError}</p>
                  ) : (
                    <p className="mt-1 text-xs text-gray-500">
                      Số 4–6 chữ số, không bắt đầu bằng chữ số 0.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700">Vai trò *</label>
                  <select
                    value={createForm.role}
                    onChange={(e) => {
                      const nextRole = e.target.value;
                      if (isAssignableEmployeeRole(nextRole)) {
                        setCreateForm((f) => ({ ...f, role: nextRole }));
                      }
                    }}
                    className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="employee">Nhân viên (employee)</option>
                    <option value="manager">Quản lý (manager)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700">Họ và tên *</label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={100}
                  value={createForm.fullName}
                  onChange={(e) => setCreateForm((f) => ({ ...f, fullName: e.target.value }))}
                  placeholder="Nguyễn Văn A"
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700">
                  Chi nhánh chính
                </label>
                <select
                  value={createForm.homeBranchId}
                  onChange={(e) =>
                    setCreateForm((f) => ({ ...f, homeBranchId: e.target.value }))
                  }
                  className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="">Chưa phân công</option>
                  {(branchesQuery.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code} - {b.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700">
                    Lương theo giờ (VNĐ) *
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    max={MAX_COMPENSATION_AMOUNT}
                    step="any"
                    value={createForm.hourlyRate}
                    onChange={(e) => setCreateForm((f) => ({ ...f, hourlyRate: e.target.value }))}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700">
                    Phụ cấp cố định (VNĐ) *
                  </label>
                  <input
                    type="number"
                    required
                    min={0}
                    max={MAX_COMPENSATION_AMOUNT}
                    step="any"
                    value={createForm.fixedAllowance}
                    onChange={(e) =>
                      setCreateForm((f) => ({ ...f, fixedAllowance: e.target.value }))
                    }
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-gray-700">
                    Mật khẩu khởi tạo (tối thiểu 8 ký tự) *
                  </label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    maxLength={128}
                    autoComplete="new-password"
                    value={createForm.password}
                    onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700">
                    Mã PIN kiosk (4–6 chữ số) *
                  </label>
                  <input
                    type="password"
                    required
                    inputMode="numeric"
                    pattern="\d{4,6}"
                    maxLength={6}
                    autoComplete="off"
                    value={createForm.pin}
                    onChange={(e) => setCreateForm((f) => ({ ...f, pin: e.target.value }))}
                    className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={createEmployeeMutation.isPending}
                  onClick={() => {
                    createModalSessionRef.current += 1;
                    nextCodeRequestIdRef.current += 1;
                    employeeCodeEditedByUserRef.current = false;
                    setIsLoadingNextCode(false);
                    setNextCodeError(null);
                    transientSecretRef.current.createPassword = '';
                    transientSecretRef.current.createPin = '';
                    setCreateForm({
                      employeeCode: '',
                      fullName: '',
                      role: 'employee',
                      homeBranchId: '',
                      hourlyRate: '0',
                      fixedAllowance: '0',
                      password: '',
                      pin: '',
                    });
                    setCreateFormError(null);
                    setIsCreateOpen(false);
                  }}
                  className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={createEmployeeMutation.isPending}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {createEmployeeMutation.isPending ? 'Đang tạo...' : 'Tạo nhân viên'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal sửa nhân viên: cập nhật vai trò (cho hồ sơ không phải admin), chi nhánh chính, lương giờ và phụ cấp */}
      {editingEmployee && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900">Sửa nhân viên</h3>
            <p className="mt-1 text-xs text-gray-600">
              Nhân viên: <span className="font-semibold">{editingEmployee.full_name}</span> (
              {editingEmployee.employee_code})
            </p>

            {editFormError && (
              <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                {editFormError}
              </div>
            )}

            <form onSubmit={handleUpdateCompensationSubmit} className="mt-4 space-y-4">
              {/* Trường Vai trò: Hồ sơ admin chỉ hiển thị read-only, hồ sơ thường cho phép đổi employee <-> manager */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-700">
                  Vai trò
                </label>
                {editingEmployee.role === 'admin' ? (
                  <div className="mt-1 space-y-1.5">
                    <input
                      type="text"
                      readOnly
                      disabled
                      value="Quản trị viên (admin)"
                      className="block w-full cursor-not-allowed rounded-md border border-gray-200 bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700"
                    />
                    <p className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                      Hồ sơ Quản trị viên (admin) chỉ hiển thị vai trò ở chế độ chỉ đọc. Không hỗ trợ nâng hoặc hạ quyền Admin trên giao diện; nếu cần thay đổi vai trò, vui lòng thực hiện trực tiếp tại Supabase.
                    </p>
                  </div>
                ) : (
                  <select
                    value={editRole}
                    onChange={(e) => {
                      const nextRole = e.target.value;
                      if (isAssignableEmployeeRole(nextRole)) {
                        setEditRole(nextRole);
                      }
                    }}
                    className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                  >
                    <option value="employee">Nhân viên (employee)</option>
                    <option value="manager">Quản lý (manager)</option>
                  </select>
                )}
              </div>

              {/* Trường Chi nhánh chính hiển thị rõ ràng */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-gray-700">
                  Chi nhánh chính
                </label>
                <select
                  value={editHomeBranchId}
                  onChange={(e) => setEditHomeBranchId(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                >
                  <option value="">Chưa phân công</option>
                  {(branchesQuery.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code} - {b.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-gray-500">
                  Chi nhánh làm việc mặc định của nhân sự (có thể để Chưa phân công).
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700">
                  Lương theo giờ (VNĐ) *
                </label>
                <input
                  type="number"
                  required
                  min={0}
                  max={MAX_COMPENSATION_AMOUNT}
                  step="any"
                  value={editHourlyRate}
                  onChange={(e) => setEditHourlyRate(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700">
                  Phụ cấp cố định (VNĐ) *
                </label>
                <input
                  type="number"
                  required
                  min={0}
                  max={MAX_COMPENSATION_AMOUNT}
                  step="any"
                  value={editFixedAllowance}
                  onChange={(e) => setEditFixedAllowance(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={updateCompensationMutation.isPending}
                  onClick={() => {
                    setEditingEmployee(null);
                    setEditRole('employee');
                    setEditHourlyRate('');
                    setEditFixedAllowance('');
                    setEditHomeBranchId('');
                    setEditFormError(null);
                  }}
                  className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={updateCompensationMutation.isPending}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {updateCompensationMutation.isPending ? 'Đang lưu...' : 'Lưu thay đổi'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal đặt lại mật khẩu */}
      {passwordTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900">Đặt lại mật khẩu đăng nhập</h3>
            <p className="mt-1 text-xs text-gray-600">
              Nhân viên: <span className="font-semibold">{passwordTarget.full_name}</span> (
              {passwordTarget.employee_code})
            </p>

            {passwordFormError && (
              <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                {passwordFormError}
              </div>
            )}

            <form onSubmit={handleResetPasswordSubmit} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700">
                  Mật khẩu mới (tối thiểu 8 ký tự) *
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700">
                  Nhập lại mật khẩu mới *
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>

              <label className="flex items-start gap-2 text-xs text-gray-700">
                <input
                  type="checkbox"
                  checked={confirmPasswordResetChecked}
                  onChange={(e) => setConfirmPasswordResetChecked(e.target.checked)}
                  className="mt-0.5 rounded border-gray-300"
                />
                <span>
                  Tôi xác nhận muốn ghi đè mật khẩu đăng nhập hiện tại của nhân viên này.
                </span>
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={resetPasswordMutation.isPending}
                  onClick={() => {
                    transientSecretRef.current.resetPassword = '';
                    setPasswordTarget(null);
                    setNewPassword('');
                    setConfirmPassword('');
                  }}
                  className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={resetPasswordMutation.isPending}
                  className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
                >
                  {resetPasswordMutation.isPending ? 'Đang xử lý...' : 'Xác nhận đặt lại'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal đặt lại mã PIN kiosk */}
      {pinTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold text-gray-900">Đặt lại mã PIN Kiosk</h3>
            <p className="mt-1 text-xs text-gray-600">
              Nhân viên: <span className="font-semibold">{pinTarget.full_name}</span> (
              {pinTarget.employee_code})
            </p>

            {pinFormError && (
              <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                {pinFormError}
              </div>
            )}

            <form onSubmit={handleResetPinSubmit} className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700">
                  Mã PIN mới (4–6 chữ số) *
                </label>
                <input
                  type="password"
                  required
                  inputMode="numeric"
                  pattern="\d{4,6}"
                  maxLength={6}
                  autoComplete="off"
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700">
                  Nhập lại mã PIN mới *
                </label>
                <input
                  type="password"
                  required
                  inputMode="numeric"
                  pattern="\d{4,6}"
                  maxLength={6}
                  autoComplete="off"
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
              </div>

              <label className="flex items-start gap-2 text-xs text-gray-700">
                <input
                  type="checkbox"
                  checked={confirmPinResetChecked}
                  onChange={(e) => setConfirmPinResetChecked(e.target.checked)}
                  className="mt-0.5 rounded border-gray-300"
                />
                <span>
                  Tôi xác nhận muốn đặt lại mã PIN chấm công kiosk và mở khóa bộ đếm sai PIN cho nhân viên này.
                </span>
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  disabled={resetPinMutation.isPending}
                  onClick={() => {
                    transientSecretRef.current.resetPin = '';
                    setPinTarget(null);
                    setNewPin('');
                    setConfirmPin('');
                  }}
                  className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={resetPinMutation.isPending}
                  className="rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
                >
                  {resetPinMutation.isPending ? 'Đang xử lý...' : 'Xác nhận đặt lại PIN'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
