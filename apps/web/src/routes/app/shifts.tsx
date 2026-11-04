import React, { useState, useEffect, useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import FullCalendar from '@fullcalendar/react';
import type { EventClickInfo, DatesSetInfo } from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/react/daygrid';
import timeGridPlugin from '@fullcalendar/react/timegrid';
import interactionPlugin from '@fullcalendar/react/interaction';
import { useAuth } from '../../lib/auth-context';
import { supabase } from '../../lib/supabase';
import {
  listMyShifts,
  listShiftTemplates,
  createMyShift,
  deletePendingShift,
  type ShiftWithBranch,
} from '../../lib/employee';
import type { Tables } from '@timekeeping/shared/database.types';

export const Route = createFileRoute('/app/shifts')({ component: EmployeeShiftsComponent });

type BranchItem = Pick<Tables<'branches'>, 'id' | 'code' | 'name'>;
type StatusStyle = { bg: string; border: string; text: string; label: string };

const DEFAULT_PENDING_STATUS: StatusStyle = { bg: '#FEF3C7', border: '#F59E0B', text: '#92400E', label: 'Chờ duyệt' };

const STATUS_COLORS: Record<string, StatusStyle> = {
  pending: DEFAULT_PENDING_STATUS,
  approved: { bg: '#D1FAE5', border: '#10B981', text: '#065F46', label: 'Đã duyệt' },
  rejected: { bg: '#FEE2E2', border: '#EF4444', text: '#991B1B', label: 'Từ chối' },
};

// Bất biến múi giờ: FullCalendar dùng timeZone="UTC" với mốc thời gian cộng +7h để luôn hiển thị theo Asia/Ho_Chi_Minh bất kể múi giờ trình duyệt; khi truy vấn CSDL sẽ trừ lại 7h từ mốc giới hạn của lịch.
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

function formatShiftError(err: unknown, fallback: string): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    if (e.code === '23P01') {
      return 'Ca làm việc bị trùng thời gian với một ca khác đã đăng ký.';
    }
    if (typeof e.message === 'string' && e.message.includes('HOME_BRANCH_REQUIRED')) {
      return 'Hồ sơ của bạn chưa được gán chi nhánh chính. Vui lòng liên hệ quản trị viên (Admin).';
    }
    if (typeof e.message === 'string' && e.message.trim()) {
      return e.message;
    }
  }
  return err instanceof Error ? err.message : fallback;
}

function getTodayVnDateString(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')?.value ?? '2025';
  const m = parts.find((p) => p.type === 'month')?.value ?? '01';
  const d = parts.find((p) => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${d}`;
}

function addDaysToDateStr(dateStr: string, days: number): string {
  const [y = 2025, m = 1, d = 1] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function toVnIsoWithOffset(localDateTimeStr: string): string {
  if (!localDateTimeStr) return '';
  const normalized = localDateTimeStr.length === 16 ? `${localDateTimeStr}:00` : localDateTimeStr;
  return `${normalized}+07:00`;
}

function formatVnDateTimeDisplay(isoStr: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(isoStr));
}

function EmployeeShiftsComponent() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [dateRange, setDateRange] = useState<{ fromIso: string; toIso: string }>(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 7);
    return { fromIso: start.toISOString(), toIso: end.toISOString() };
  });

  const todayStr = useMemo(() => getTodayVnDateString(), []);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [startLocal, setStartLocal] = useState<string>(`${todayStr}T08:00`);
  const [endLocal, setEndLocal] = useState<string>(`${todayStr}T17:00`);
  const [note, setNote] = useState<string>('');
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const [selectedShift, setSelectedShift] = useState<ShiftWithBranch | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const shiftsQuery = useQuery({
    queryKey: ['my-shifts', user?.id, dateRange.fromIso, dateRange.toIso],
    queryFn: () => listMyShifts(dateRange.fromIso, dateRange.toIso),
    enabled: Boolean(user?.id && dateRange.fromIso && dateRange.toIso),
  });

  const templatesQuery = useQuery({
    queryKey: ['shift-templates', user?.id],
    queryFn: () => listShiftTemplates(),
    enabled: Boolean(user?.id),
  });

  // Truy vấn chi nhánh chính (home_branch_id) từ hồ sơ nhân viên đang đăng nhập
  const employeeProfileQuery = useQuery({
    queryKey: ['employee-home-branch', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select('home_branch_id')
        .eq('id', user!.id)
        .single();
      if (error) throw error;
      return data as unknown as { home_branch_id: string | null };
    },
    enabled: Boolean(user?.id),
  });

  const branchesQuery = useQuery({
    queryKey: ['branches-list', user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('branches')
        .select('id, code, name')
        .order('name', { ascending: true });
      if (error) throw error;
      return (data ?? []) as BranchItem[];
    },
    enabled: Boolean(user?.id),
  });

  const branchOptions = useMemo(() => {
    return branchesQuery.data ?? [];
  }, [branchesQuery.data]);

  const homeBranchId = employeeProfileQuery.data?.home_branch_id ?? null;
  const isProfileReady =
    !employeeProfileQuery.isLoading && !employeeProfileQuery.isError && Boolean(homeBranchId);

  // Lấy thông tin hiển thị của chi nhánh chính từ danh sách chi nhánh hiện có
  const homeBranch = useMemo(() => {
    if (!homeBranchId) return null;
    return branchOptions.find((b) => b.id === homeBranchId) ?? null;
  }, [homeBranchId, branchOptions]);

  // Danh sách ca mẫu dùng chung để điền nhanh khung giờ làm việc
  const availableTemplates = useMemo(() => {
    return templatesQuery.data ?? [];
  }, [templatesQuery.data]);

  // Đăng ký kênh Realtime lắng nghe thay đổi ca làm việc của nhân viên hiện tại
  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`employee-shifts-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'shifts',
          filter: `employee_id=eq.${user.id}`,
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ['my-shifts', user.id] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id, queryClient]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) {
        throw new Error('Không xác định được tài khoản nhân viên đang đăng nhập.');
      }
      if (employeeProfileQuery.isLoading) {
        throw new Error('Đang tải hồ sơ nhân viên, vui lòng đợi trong giây lát.');
      }
      if (employeeProfileQuery.isError || !homeBranchId) {
        throw new Error('Hồ sơ chưa được gán chi nhánh chính. Vui lòng liên hệ quản trị viên (Admin).');
      }
      if (!startLocal || !endLocal) {
        throw new Error('Vui lòng nhập đầy đủ thời gian bắt đầu và kết thúc.');
      }

      const startAt = toVnIsoWithOffset(startLocal);
      const endAt = toVnIsoWithOffset(endLocal);

      return createMyShift({
        employeeId: user.id,
        branchId: homeBranchId,
        startAt,
        endAt,
        note,
      });
    },
    onSuccess: () => {
      setFormError(null);
      setFormSuccess('Đăng ký ca làm việc thành công (đang chờ duyệt).');
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['my-shifts', user?.id] });
    },
    onError: (err: unknown) => {
      setFormSuccess(null);
      setFormError(formatShiftError(err, 'Không thể đăng ký ca làm việc. Vui lòng thử lại.'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (shiftId: string) => {
      await deletePendingShift(shiftId);
    },
    onSuccess: () => {
      setActionError(null);
      setSelectedShift(null);
      queryClient.invalidateQueries({ queryKey: ['my-shifts', user?.id] });
    },
    onError: (err: unknown) => {
      setActionError(formatShiftError(err, 'Không thể xóa ca chờ duyệt. Vui lòng thử lại.'));
    },
  });

  // Ca mẫu chỉ dùng để điền nhanh khung giờ làm việc, tuyệt đối không thay đổi chi nhánh đăng ký
  const handleTemplateChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const tplId = e.target.value;
    setSelectedTemplateId(tplId);
    if (!tplId) return;

    const tpl = availableTemplates.find((t) => t.id === tplId);
    if (!tpl) return;

    const baseDate = startLocal.slice(0, 10) || getTodayVnDateString();
    const startHm = tpl.start_time.slice(0, 5);
    const endHm = tpl.end_time.slice(0, 5);

    const isOvernight = endHm <= startHm;
    const endDate = isOvernight ? addDaysToDateStr(baseDate, 1) : baseDate;

    setStartLocal(`${baseDate}T${startHm}`);
    setEndLocal(`${endDate}T${endHm}`);
  };

  const handleDatesSet = (arg: DatesSetInfo) => {
    const nextFrom = new Date(arg.start.getTime() - VN_OFFSET_MS).toISOString();
    const nextTo = new Date(arg.end.getTime() - VN_OFFSET_MS).toISOString();
    setDateRange((prev) =>
      prev.fromIso === nextFrom && prev.toIso === nextTo ? prev : { fromIso: nextFrom, toIso: nextTo }
    );
  };

  const handleEventClick = (arg: EventClickInfo) => {
    const shift = arg.event.extendedProps.shift as ShiftWithBranch | undefined;
    if (shift) {
      setActionError(null);
      setSelectedShift(shift);
    }
  };

  const calendarEvents = useMemo(() => {
    return (shiftsQuery.data ?? []).map((shift) => {
      const statusCfg = STATUS_COLORS[shift.status] ?? DEFAULT_PENDING_STATUS;
      const branchCode = shift.branches?.code ?? 'CN';
      return {
        id: shift.id,
        title: `[${branchCode}] ${statusCfg.label}`,
        start: new Date(Date.parse(shift.start_at) + VN_OFFSET_MS).toISOString(),
        end: new Date(Date.parse(shift.end_at) + VN_OFFSET_MS).toISOString(),
        backgroundColor: statusCfg.bg,
        borderColor: statusCfg.border,
        textColor: statusCfg.text,
        classNames: [`fc-shift-status-${shift.status}`],
        extendedProps: { shift },
      };
    });
  }, [shiftsQuery.data]);

  const canDeleteSelected = useMemo(() => {
    if (!selectedShift) return false;
    const isFuture = new Date(selectedShift.start_at).getTime() > Date.now();
    return selectedShift.status === 'pending' && isFuture;
  }, [selectedShift]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    if (employeeProfileQuery.isLoading) {
      setFormError('Hồ sơ nhân viên đang tải, vui lòng thử lại sau giây lát.');
      return;
    }
    if (employeeProfileQuery.isError || !homeBranchId) {
      setFormError('Hồ sơ chưa có chi nhánh chính hoặc bị lỗi tải dữ liệu. Vui lòng liên hệ quản trị viên (Admin).');
      return;
    }
    createMutation.mutate();
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 sm:space-y-6">
      {/* Tiêu đề trang và chú giải trạng thái giúp nhân viên quét thông tin nhanh */}
      <div className="flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-bold text-gray-900 sm:text-xl">Ca làm việc</h1>
          <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">
            Đăng ký lịch làm việc và theo dõi trạng thái duyệt theo múi giờ Việt Nam (GMT+7)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Chú giải trạng thái ca">
          {Object.entries(STATUS_COLORS).map(([key, cfg]) => (
            <span
              key={key}
              className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-semibold"
              style={{ backgroundColor: cfg.bg, borderColor: cfg.border, color: cfg.text }}
            >
              <span
                className="inline-block h-2.5 w-2.5 rounded-full border"
                style={{ backgroundColor: cfg.border, borderColor: cfg.text }}
              />
              {cfg.label}
            </span>
          ))}
        </div>
      </div>

      {/* Biểu mẫu đăng ký ca mới */}
      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="mb-4 border-b border-gray-100 pb-3">
          <h2 className="text-base font-semibold text-gray-900">Đăng ký ca làm việc</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            Chọn ca mẫu để điền nhanh thời gian hoặc tự nhập khung giờ làm việc tại chi nhánh chính.
          </p>
        </div>

        {!employeeProfileQuery.isLoading && (employeeProfileQuery.isError || !homeBranchId) && (
          <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            {employeeProfileQuery.isError
              ? 'Không thể tải thông tin chi nhánh chính từ hồ sơ của bạn. Vui lòng thử lại hoặc liên hệ quản trị viên (Admin).'
              : 'Hồ sơ của bạn chưa được gán chi nhánh chính. Vui lòng liên hệ quản trị viên (Admin) để được cấu hình trước khi đăng ký ca.'}
          </div>
        )}

        {formError && (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {formError}
          </div>
        )}
        {formSuccess && (
          <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
            {formSuccess}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <div>
            <label htmlFor="shift-template" className="mb-1.5 block text-xs font-semibold text-gray-700">Ca mẫu (tùy chọn)</label>
            <select
              id="shift-template"
              value={selectedTemplateId}
              onChange={handleTemplateChange}
              className="min-h-[42px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
            >
              <option value="">-- Chọn ca mẫu để điền nhanh --</option>
              {availableTemplates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name} ({tpl.start_time.slice(0, 5)} - {tpl.end_time.slice(0, 5)})
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="mb-1.5 block text-xs font-semibold text-gray-700">Chi nhánh chính</span>
            <div
              aria-readonly="true"
              className="flex min-h-[42px] w-full items-center rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700"
            >
              {employeeProfileQuery.isLoading
                ? 'Đang tải chi nhánh chính...'
                : employeeProfileQuery.isError
                  ? 'Lỗi tải hồ sơ (Liên hệ Admin)'
                  : homeBranch
                    ? `${homeBranch.code} - ${homeBranch.name}`
                    : homeBranchId
                      ? homeBranchId
                      : 'Chưa gán chi nhánh chính (Liên hệ Admin)'}
            </div>
          </div>

          </div>
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          <div>
            <label htmlFor="shift-start" className="mb-1.5 block text-xs font-semibold text-gray-700">Bắt đầu (Giờ VN +07) <span className="text-red-500">*</span></label>
            <input
              id="shift-start"
              type="datetime-local"
              required
              value={startLocal}
              onChange={(e) => setStartLocal(e.target.value)}
              className="min-h-[42px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="shift-end" className="mb-1.5 block text-xs font-semibold text-gray-700">Kết thúc (Giờ VN +07) <span className="text-red-500">*</span></label>
            <input
              id="shift-end"
              type="datetime-local"
              required
              value={endLocal}
              onChange={(e) => setEndLocal(e.target.value)}
              className="min-h-[42px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
            />
          </div>
          </div>

          <div className="flex flex-col gap-3.5 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="shift-note" className="mb-1.5 block text-xs font-semibold text-gray-700">Ghi chú</label>
            <input
              id="shift-note"
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Ghi chú thêm (nếu có)"
              className="min-h-[42px] w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 focus:outline-none"
            />
          </div>

            <button
              type="submit"
              disabled={createMutation.isPending || !isProfileReady}
              className="min-h-[42px] w-full rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-xs transition hover:bg-blue-700 disabled:opacity-50 sm:w-auto"
            >
              {createMutation.isPending ? 'Đang gửi...' : 'Đăng ký ca'}
            </button>
          </div>
        </form>
      </div>

      {/* Chi tiết ca làm việc được chọn */}
      {selectedShift && (
        <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 shadow-sm">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
            <div className="space-y-1.5 text-sm text-gray-800">
              <div className="font-semibold text-gray-900">
                Chi nhánh: {selectedShift.branches?.name ?? selectedShift.branch_id} (
                {selectedShift.branches?.code ?? 'N/A'})
              </div>
              <div>
                Thời gian: {formatVnDateTimeDisplay(selectedShift.start_at)} &rarr;{' '}
                {formatVnDateTimeDisplay(selectedShift.end_at)}
              </div>
              <div className="flex items-center gap-2">
                Trạng thái:{' '}
                <span
                  className="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold"
                  style={{
                    backgroundColor: (STATUS_COLORS[selectedShift.status] ?? DEFAULT_PENDING_STATUS).bg,
                    borderColor: (STATUS_COLORS[selectedShift.status] ?? DEFAULT_PENDING_STATUS).border,
                    color: (STATUS_COLORS[selectedShift.status] ?? DEFAULT_PENDING_STATUS).text,
                  }}
                >
                  {STATUS_COLORS[selectedShift.status]?.label ?? selectedShift.status}
                </span>
              </div>
              {selectedShift.note && <div>Ghi chú: {selectedShift.note}</div>}
              {actionError && <div className="text-xs font-medium text-red-600">{actionError}</div>}
            </div>
            <div className="flex items-center gap-2 pt-1 sm:pt-0">
              {canDeleteSelected && (
                <button
                  type="button"
                  disabled={deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate(selectedShift.id)}
                  className="min-h-[38px] flex-1 rounded-lg bg-red-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50 sm:flex-none"
                >
                  {deleteMutation.isPending ? 'Đang xóa...' : 'Hủy ca chờ duyệt'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setSelectedShift(null)}
                className="min-h-[38px] flex-1 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 sm:flex-none"
              >
                Đóng
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lịch hiển thị ca làm việc */}
      <div className="shift-calendar-wrapper rounded-xl border border-gray-200 bg-white p-3 shadow-sm sm:p-4">
        <div className="mb-3 flex flex-col justify-between gap-1 border-b border-gray-100 pb-2.5 sm:flex-row sm:items-center">
          <h2 className="text-base font-semibold text-gray-900">Lịch ca làm việc</h2>
          <p className="text-xs text-gray-500">Chạm vào một ca trên lịch để xem chi tiết hoặc hủy ca chờ duyệt</p>
        </div>
        {shiftsQuery.isError && (
          <div className="mb-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            Không thể tải danh sách ca làm việc. Vui lòng thử lại sau.
          </div>
        )}
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="timeGridWeek"
          timeZone="UTC"
          initialDate={todayStr}
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek,timeGridDay',
          }}
          locale="vi"
          firstDay={1}
          allDaySlot={false}
          dayMaxEvents={true}
          expandRows={true}
          height="auto"
          events={calendarEvents}
          datesSet={handleDatesSet}
          eventClick={handleEventClick}
        />
      </div>
    </div>
  );
}
