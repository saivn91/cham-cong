import { Fragment, useState, useEffect, useMemo } from 'react';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Database } from '@timekeeping/shared/database.types';
import { useAuth } from '../../../lib/auth-context';
import { supabase } from '../../../lib/supabase';

export const Route = createFileRoute('/admin/payroll/preview')({
  component: PayrollPreviewAndApprovalPage,
});

type PayrollPeriod = Database['public']['Tables']['payroll_periods']['Row'];
type EmployeeProfile = Pick<
  Database['public']['Tables']['employees']['Row'],
  'id' | 'employee_code' | 'full_name' | 'is_active'
>;
type MonthlyAllowanceRecord = Pick<
  Database['public']['Tables']['monthly_allowances']['Row'],
  'id' | 'period_id' | 'employee_id' | 'amount' | 'reason'
>;

type PayrollBucket =
  | 'regular_day'
  | 'regular_night'
  | 'ot_day'
  | 'ot_night'
  | 'holiday_day'
  | 'holiday_night';

// Cấu trúc từng block 15 phút được trả lương trong mảng block_details từ fn_calculate_payroll_base
interface PreviewBlockDetail {
  session_no: number;
  block_start: string;
  block_start_vn: string;
  weekly_start_vn: string;
  minutes: number;
  bucket: PayrollBucket;
  weekly_regular_seq: number | null;
  is_cross_month: boolean;
  session_started_month: string;
  session_clock_in: string;
  session_clock_out: string;
  session_rounded_in: string;
  session_rounded_out: string;
  break_blocks: number;
  break_minutes: number;
}

// Cấu trúc dòng dữ liệu tạm tính trả về từ RPC preview_timesheet (fn_calculate_payroll_base)
// Khi gọi tổng quan (p_employee_id = null), block_details được lượt bỏ; khi gọi chi tiết từng nhân viên, block_details trả đầy đủ
interface PreviewTimesheetRow {
  employee_id: string;
  hourly_rate_snapshot: number;
  fixed_allowance_snapshot: number;
  minutes_regular_day: number;
  minutes_regular_night: number;
  minutes_ot_day: number;
  minutes_ot_night: number;
  minutes_holiday_day: number;
  minutes_holiday_night: number;
  hourly_pay_subtotal: number;
  total_allowance: number;
  total_salary: number;
  block_details: PreviewBlockDetail[];
}

// Nhóm các block 15 phút theo từng phiên làm việc (session_no) để hiển thị chi tiết minh bạch
interface SessionBlockGroup {
  session_no: number;
  weekly_start_vn: string;
  is_cross_month: boolean;
  session_started_month: string;
  session_clock_in: string;
  session_clock_out: string;
  session_rounded_in: string;
  session_rounded_out: string;
  break_blocks: number;
  break_minutes: number;
  blocks: PreviewBlockDetail[];
}

// Cấu trúc chi tiết lỗi ORPHANED_PUNCHES trả về trong error.details khi còn phiên chấm công treo
interface OrphanedPunchDetail {
  employee_id: string;
  employee_code: string;
  full_name: string;
  last_type: string;
  last_punch_at: string | null;
}

const vndFormatter = new Intl.NumberFormat('vi-VN');
const vnDateTimeFormatter = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const VALID_BUCKETS: ReadonlySet<PayrollBucket> = new Set<PayrollBucket>([
  'regular_day',
  'regular_night',
  'ot_day',
  'ot_night',
  'holiday_day',
  'holiday_night',
]);

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function toSafeBucket(val: unknown): PayrollBucket {
  const str = String(val ?? '') as PayrollBucket;
  return VALID_BUCKETS.has(str) ? str : 'regular_day';
}

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

// Định dạng chuỗi YYYY-MM-DDTHH:mm:ss giờ VN trả thẳng từ DB mà không phụ thuộc timezone trình duyệt
function formatVnLiteralTimestamp(vnIso: string): string {
  if (!vnIso) return '—';
  const [datePart, timePart] = vnIso.split('T');
  if (!datePart) return vnIso;
  const [yyyy, mm, dd] = datePart.split('-');
  const formattedDate = yyyy && mm && dd ? `${dd}/${mm}/${yyyy}` : datePart;
  if (!timePart) return formattedDate;
  return `${formattedDate} ${timePart.slice(0, 5)}`;
}

function formatVnDateOnlyLiteral(vnIso: string): string {
  if (!vnIso) return '—';
  const [datePart] = vnIso.split('T');
  if (!datePart) return vnIso;
  const [yyyy, mm, dd] = datePart.split('-');
  return yyyy && mm && dd ? `${dd}/${mm}/${yyyy}` : datePart;
}

// Định dạng timestamptz ISO từ DB luôn cố định theo múi giờ Asia/Ho_Chi_Minh
function formatTimestamptzVN(isoStr: string | null | undefined): string {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return String(isoStr);
  return vnDateTimeFormatter.format(d);
}

function getBucketMeta(bucket: PayrollBucket): {
  label: string;
  multiplier: string;
  badgeClass: string;
} {
  switch (bucket) {
    case 'regular_day':
      return {
        label: 'Thường ngày',
        multiplier: '1.0x',
        badgeClass: 'bg-gray-100 text-gray-800 border-gray-300',
      };
    case 'regular_night':
      return {
        label: 'Thường đêm',
        multiplier: '1.3x',
        badgeClass: 'bg-indigo-50 text-indigo-800 border-indigo-200',
      };
    case 'ot_day':
      return {
        label: 'Tăng ca ngày',
        multiplier: '1.5x',
        badgeClass: 'bg-amber-50 text-amber-800 border-amber-200',
      };
    case 'ot_night':
      return {
        label: 'Tăng ca đêm',
        multiplier: '1.8x',
        badgeClass: 'bg-orange-50 text-orange-800 border-orange-200',
      };
    case 'holiday_day':
      return {
        label: 'Lễ ngày',
        multiplier: '2.0x',
        badgeClass: 'bg-rose-50 text-rose-800 border-rose-200',
      };
    case 'holiday_night':
      return {
        label: 'Lễ đêm',
        multiplier: '2.3x',
        badgeClass: 'bg-purple-50 text-purple-800 border-purple-200',
      };
  }
}

function formatPunchTypeLabel(type: string): string {
  switch (type) {
    case 'clock_in':
      return 'Vào ca (Chưa ra ca)';
    case 'break_start':
      return 'Bắt đầu nghỉ (Chưa kết thúc nghỉ)';
    case 'break_end':
      return 'Kết thúc nghỉ (Chưa ra ca)';
    case 'invalid_sequence':
      return 'Sai trình tự chấm công (Thiếu giờ vào ca)';
    default:
      return type;
  }
}

function parseBlockDetail(raw: unknown): PreviewBlockDetail | null {
  if (!isRecord(raw)) return null;
  return {
    session_no: Number(raw.session_no ?? 0),
    block_start: String(raw.block_start ?? ''),
    block_start_vn: String(raw.block_start_vn ?? ''),
    weekly_start_vn: String(raw.weekly_start_vn ?? ''),
    minutes: Number(raw.minutes ?? 15),
    bucket: toSafeBucket(raw.bucket),
    weekly_regular_seq:
      raw.weekly_regular_seq === null || raw.weekly_regular_seq === undefined
        ? null
        : Number(raw.weekly_regular_seq),
    is_cross_month: Boolean(raw.is_cross_month),
    session_started_month: String(raw.session_started_month ?? ''),
    session_clock_in: String(raw.session_clock_in ?? ''),
    session_clock_out: String(raw.session_clock_out ?? ''),
    session_rounded_in: String(raw.session_rounded_in ?? ''),
    session_rounded_out: String(raw.session_rounded_out ?? ''),
    break_blocks: Number(raw.break_blocks ?? 0),
    break_minutes: Number(raw.break_minutes ?? 0),
  };
}

function parsePreviewTimesheetRow(raw: unknown): PreviewTimesheetRow | null {
  if (!isRecord(raw)) return null;
  const rawBlocks = Array.isArray(raw.block_details) ? raw.block_details : [];
  const blockDetails: PreviewBlockDetail[] = [];
  for (const item of rawBlocks) {
    const parsed = parseBlockDetail(item);
    if (parsed) blockDetails.push(parsed);
  }

  return {
    employee_id: String(raw.employee_id ?? ''),
    hourly_rate_snapshot: Number(raw.hourly_rate_snapshot ?? 0),
    fixed_allowance_snapshot: Number(raw.fixed_allowance_snapshot ?? 0),
    minutes_regular_day: Number(raw.minutes_regular_day ?? 0),
    minutes_regular_night: Number(raw.minutes_regular_night ?? 0),
    minutes_ot_day: Number(raw.minutes_ot_day ?? 0),
    minutes_ot_night: Number(raw.minutes_ot_night ?? 0),
    minutes_holiday_day: Number(raw.minutes_holiday_day ?? 0),
    minutes_holiday_night: Number(raw.minutes_holiday_night ?? 0),
    hourly_pay_subtotal: Number(raw.hourly_pay_subtotal ?? 0),
    total_allowance: Number(raw.total_allowance ?? 0),
    total_salary: Number(raw.total_salary ?? 0),
    block_details: blockDetails,
  };
}

// Phân tích phản hồi JSON khi gọi preview_timesheet cho 1 nhân viên (có thể là mảng 1 phần tử hoặc object)
function parseSingleEmployeeDetailRow(data: unknown, employeeId: string): PreviewTimesheetRow {
  if (Array.isArray(data)) {
    for (const item of data) {
      const parsed = parsePreviewTimesheetRow(item);
      if (parsed && (!parsed.employee_id || parsed.employee_id === employeeId)) {
        return parsed;
      }
    }
    const first = data[0] ? parsePreviewTimesheetRow(data[0]) : null;
    if (first) return first;
  } else if (isRecord(data)) {
    const parsed = parsePreviewTimesheetRow(data);
    if (parsed) return parsed;
  }

  return {
    employee_id: employeeId,
    hourly_rate_snapshot: 0,
    fixed_allowance_snapshot: 0,
    minutes_regular_day: 0,
    minutes_regular_night: 0,
    minutes_ot_day: 0,
    minutes_ot_night: 0,
    minutes_holiday_day: 0,
    minutes_holiday_night: 0,
    hourly_pay_subtotal: 0,
    total_allowance: 0,
    total_salary: 0,
    block_details: [],
  };
}

function groupBlocksBySession(blocks: PreviewBlockDetail[]): SessionBlockGroup[] {
  const map = new Map<number, SessionBlockGroup>();
  for (const b of blocks) {
    const existing = map.get(b.session_no);
    if (existing) {
      existing.blocks.push(b);
    } else {
      map.set(b.session_no, {
        session_no: b.session_no,
        weekly_start_vn: b.weekly_start_vn,
        is_cross_month: b.is_cross_month,
        session_started_month: b.session_started_month,
        session_clock_in: b.session_clock_in,
        session_clock_out: b.session_clock_out,
        session_rounded_in: b.session_rounded_in,
        session_rounded_out: b.session_rounded_out,
        break_blocks: b.break_blocks,
        break_minutes: b.break_minutes,
        blocks: [b],
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.session_no - b.session_no);
}

// Phân tích an toàn mảng JSON từ error.details khi DB báo lỗi ORPHANED_PUNCHES
function parseOrphanedPunchesError(err: unknown): {
  isOrphanError: boolean;
  orphans: OrphanedPunchDetail[];
  rawMessage: string;
} {
  const errObj = isRecord(err) ? err : {};
  const message = String(errObj.message ?? '');
  const details = errObj.details;
  const isOrphanError =
    message.includes('ORPHANED_PUNCHES') ||
    (typeof details === 'string' && details.includes('last_punch_at'));

  if (!isOrphanError) {
    return {
      isOrphanError: false,
      orphans: [],
      rawMessage: message || 'Đã xảy ra lỗi khi duyệt bảng công.',
    };
  }

  let parsedRaw: unknown[] = [];
  if (typeof details === 'string' && details.trim()) {
    try {
      const json: unknown = JSON.parse(details);
      if (Array.isArray(json)) {
        parsedRaw = json;
      }
    } catch {
      parsedRaw = [];
    }
  } else if (Array.isArray(details)) {
    parsedRaw = details;
  }

  const orphans: OrphanedPunchDetail[] = [];
  for (const item of parsedRaw) {
    if (isRecord(item)) {
      orphans.push({
        employee_id: String(item.employee_id ?? ''),
        employee_code: String(item.employee_code ?? ''),
        full_name: String(item.full_name ?? ''),
        last_type: String(item.last_type ?? ''),
        last_punch_at:
          item.last_punch_at === null || item.last_punch_at === undefined
            ? null
            : String(item.last_punch_at),
      });
    }
  }

  return {
    isOrphanError: true,
    orphans,
    rawMessage:
      'Không thể duyệt kỳ lương do còn nhân viên có phiên chấm công chưa đóng hoặc sai trình tự.',
  };
}

interface EmployeeBlockDetailsSectionProps {
  userId: string | undefined;
  isAdmin: boolean;
  periodId: string;
  isPeriodOpen: boolean;
  employeeId: string;
  empCode: string;
  empName: string;
  isExpanded: boolean;
}

// Component tải lười (lazy-load) chi tiết block_details của từng nhân viên khi được mở rộng
function EmployeeBlockDetailsSection({
  userId,
  isAdmin,
  periodId,
  isPeriodOpen,
  employeeId,
  empCode,
  empName,
  isExpanded,
}: EmployeeBlockDetailsSectionProps) {
  const detailQueryKey = ['payroll-preview-detail', userId, periodId, employeeId];

  const {
    data: detailRow,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: detailQueryKey,
    enabled: !!userId && isAdmin && !!periodId && isPeriodOpen && isExpanded,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error: rpcError } = await supabase.rpc('preview_timesheet', {
        p_period_id: periodId,
        p_employee_id: employeeId,
      });
      if (rpcError) throw rpcError;
      return parseSingleEmployeeDetailRow(data, employeeId);
    },
  });

  const blockDetails = useMemo(() => detailRow?.block_details ?? [], [detailRow]);
  const sessionGroups = useMemo(() => groupBlocksBySession(blockDetails), [blockDetails]);

  if (isLoading) {
    return (
      <div className="p-4 bg-white border border-gray-200 rounded-md text-xs text-gray-600 text-center">
        Đang tải chi tiết các block 15 phút của nhân viên {empCode} ({empName})...
      </div>
    );
  }

  if (error) {
    const parsedErr = parseOrphanedPunchesError(error);
    const errText = parsedErr.isOrphanError
      ? parsedErr.rawMessage
      : error instanceof Error
        ? error.message
        : String(error);

    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-md flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="text-xs text-red-700">
          <span className="font-semibold">Không thể tải chi tiết block công:</span> {errText}
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="self-start sm:self-auto px-3 py-1.5 bg-white hover:bg-red-100 text-red-700 border border-red-300 rounded text-xs font-semibold"
        >
          Thử lại
        </button>
      </div>
    );
  }

  if (!detailRow) {
    return null;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="text-xs font-bold text-gray-800">
          Chi tiết các block 15 phút được trả lương — {empCode} ({empName})
        </div>
        <div className="text-[11px] text-gray-500">
          Múi giờ chuẩn: Asia/Ho_Chi_Minh • Tổng số phiên trong kỳ:{' '}
          <span className="font-semibold text-gray-800">{sessionGroups.length}</span> • Tổng số
          block được trả:{' '}
          <span className="font-semibold text-gray-800">{blockDetails.length}</span> (
          {blockDetails.length * 15} phút)
        </div>
      </div>

      {sessionGroups.length === 0 ? (
        <div className="p-4 bg-white border border-gray-200 rounded-md text-xs text-gray-500 text-center">
          Nhân viên này chưa có block công 15 phút nào được trả lương trong kỳ này (chỉ phát sinh phụ cấp cố định hoặc phụ cấp tháng).
        </div>
      ) : (
        <div className="space-y-3">
          {sessionGroups.map((session) => (
            <details
              key={session.session_no}
              open
              className="bg-white border border-gray-200 rounded-md overflow-hidden shadow-xs"
            >
              <summary className="cursor-pointer select-none px-3 py-2.5 bg-gray-100/80 hover:bg-gray-100 border-b border-gray-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold text-gray-900">Phiên #{session.session_no}</span>
                  <span className="text-gray-700">
                    Vào/Ra thực tế:{' '}
                    <span className="font-medium text-gray-900">
                      {formatTimestamptzVN(session.session_clock_in)} →{' '}
                      {formatTimestamptzVN(session.session_clock_out)}
                    </span>
                  </span>
                  <span className="text-gray-600">
                    (Làm tròn 15p:{' '}
                    <span className="font-medium text-gray-800">
                      {formatTimestamptzVN(session.session_rounded_in)} →{' '}
                      {formatTimestamptzVN(session.session_rounded_out)}
                    </span>
                    )
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  {session.is_cross_month && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded font-semibold bg-amber-100 text-amber-900 border border-amber-300">
                      Ca vắt tháng — Gán kỳ {session.session_started_month} (theo giờ vào ca)
                    </span>
                  )}
                  <span className="inline-flex items-center px-2 py-0.5 rounded bg-blue-50 text-blue-800 border border-blue-200 font-medium">
                    Tuần của giờ vào ca: Thứ Hai {formatVnDateOnlyLiteral(session.weekly_start_vn)}
                  </span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded bg-gray-100 text-gray-700 border border-gray-300 font-medium">
                    Nghỉ khấu trừ: {session.break_blocks} block ({session.break_minutes} phút)
                  </span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-semibold">
                    Được tính lương: {session.blocks.length} block ({session.blocks.length * 15}{' '}
                    phút)
                  </span>
                </div>
              </summary>

              <div className="p-2 sm:p-3 overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-left text-[11px] border-collapse">
                  <thead>
                    <tr className="bg-gray-50 text-gray-600 border-b border-gray-200">
                      <th className="py-1.5 px-2 border-r border-gray-200 w-12">#</th>
                      <th className="py-1.5 px-2 border-r border-gray-200">
                        Mốc block 15p (Giờ VN)
                      </th>
                      <th className="py-1.5 px-2 border-r border-gray-200">Phân loại & Hệ số</th>
                      <th className="py-1.5 px-2 border-r border-gray-200">
                        Thứ tự block tuần (≤192 thường, &gt;192 OT)
                      </th>
                      <th className="py-1.5 px-2 border-r border-gray-200">Tuần tính ngưỡng 48h</th>
                      <th className="py-1.5 px-2 text-right">Số phút</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {session.blocks.map((blk, bIdx) => {
                      const meta = getBucketMeta(blk.bucket);
                      return (
                        <tr
                          key={`${blk.session_no}-${blk.block_start}-${bIdx}`}
                          className="hover:bg-gray-50"
                        >
                          <td className="py-1.5 px-2 border-r border-gray-100 font-mono text-gray-500">
                            {bIdx + 1}
                          </td>
                          <td className="py-1.5 px-2 border-r border-gray-100 font-mono font-medium text-gray-800 whitespace-nowrap">
                            {formatVnLiteralTimestamp(blk.block_start_vn)}
                          </td>
                          <td className="py-1.5 px-2 border-r border-gray-100 whitespace-nowrap">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-semibold ${meta.badgeClass}`}
                            >
                              <span>{meta.label}</span>
                              <span>({meta.multiplier})</span>
                            </span>
                          </td>
                          <td className="py-1.5 px-2 border-r border-gray-100 font-mono text-gray-700 whitespace-nowrap">
                            {blk.weekly_regular_seq === null
                              ? 'Ngày lễ (Không tính vào 192 block tuần)'
                              : `Block #${blk.weekly_regular_seq} / 192`}
                          </td>
                          <td className="py-1.5 px-2 border-r border-gray-100 text-gray-600 whitespace-nowrap">
                            Tuần {formatVnDateOnlyLiteral(blk.weekly_start_vn)}
                          </td>
                          <td className="py-1.5 px-2 text-right font-semibold text-gray-800 whitespace-nowrap">
                            {blk.minutes} phút
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function PayrollPreviewAndApprovalPage() {
  const { user, role } = useAuth();
  const qc = useQueryClient();
  const router = useRouter();
  const isAdmin = role === 'admin';

  const [selectedPeriodId, setSelectedPeriodId] = useState<string>('');
  const [expandedEmployees, setExpandedEmployees] = useState<Record<string, boolean>>({});
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [errMessage, setErrMessage] = useState<string>('');
  const [orphanedPunches, setOrphanedPunches] = useState<OrphanedPunchDetail[]>([]);
  const [successMessage, setSuccessMessage] = useState<string>('');

  // 1. Truy vấn danh sách kỳ lương, sắp xếp giảm dần từ mới nhất
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

  // Tự động chọn kỳ đang mở mới nhất hoặc kỳ đầu tiên trong danh sách
  useEffect(() => {
    if (!selectedPeriodId && periods.length > 0) {
      const defaultPeriod = periods.find((p) => p.status === 'open') ?? periods[0];
      if (defaultPeriod) setSelectedPeriodId(defaultPeriod.id);
    }
  }, [periods, selectedPeriodId]);

  const selectedPeriod = useMemo(
    () => periods.find((p) => p.id === selectedPeriodId) ?? null,
    [periods, selectedPeriodId]
  );
  const isPeriodOpen = selectedPeriod?.status === 'open';

  // 2. Truy vấn hồ sơ nhân viên để ánh xạ mã NV và họ tên
  const employeesKey = ['employees-payroll-directory', user?.id, role];
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

  // 3. Truy vấn lý do phụ cấp hàng tháng thực tế của kỳ lương để hiển thị chi tiết minh bạch
  const allowancesKey = ['monthly-allowances', user?.id, selectedPeriodId];
  const { data: monthlyAllowances = [] } = useQuery({
    queryKey: allowancesKey,
    enabled: !!user && isAdmin && !!selectedPeriodId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('monthly_allowances')
        .select('id,period_id,employee_id,amount,reason')
        .eq('period_id', selectedPeriodId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as MonthlyAllowanceRecord[];
    },
  });

  const allowancesByEmployee = useMemo(() => {
    const map = new Map<string, MonthlyAllowanceRecord[]>();
    for (const item of monthlyAllowances) {
      const list = map.get(item.employee_id) ?? [];
      list.push(item);
      map.set(item.employee_id, list);
    }
    return map;
  }, [monthlyAllowances]);

  // 4. Chỉ gọi RPC preview_timesheet tổng quan khi kỳ lương đang ở trạng thái 'open'
  // Toàn bộ lương giờ tạm tính, phụ cấp và tổng lương lấy trực tiếp từ fn_calculate_payroll_base (không kèm block_details để tối ưu dung lượng)
  const previewKey = ['payroll-preview', user?.id, selectedPeriodId];
  const {
    data: previewRows = [],
    isLoading: previewLoading,
    error: previewError,
    refetch: refetchPreview,
  } = useQuery({
    queryKey: previewKey,
    enabled: !!user && isAdmin && !!selectedPeriodId && isPeriodOpen,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('preview_timesheet', {
        p_period_id: selectedPeriodId,
      });
      if (error) throw error;
      const rawArray: unknown[] = Array.isArray(data) ? data : [];
      const rows: PreviewTimesheetRow[] = [];
      for (const item of rawArray) {
        const parsed = parsePreviewTimesheetRow(item);
        if (parsed) rows.push(parsed);
      }
      return rows;
    },
  });

  // Sắp xếp danh sách xem trước theo mã nhân viên
  const sortedPreviewRows = useMemo(() => {
    return [...previewRows].sort((a, b) => {
      const codeA = employeeMap.get(a.employee_id)?.employee_code ?? a.employee_id;
      const codeB = employeeMap.get(b.employee_id)?.employee_code ?? b.employee_id;
      return codeA.localeCompare(codeB);
    });
  }, [previewRows, employeeMap]);

  const toggleEmployeeDetails = (employeeId: string) => {
    setExpandedEmployees((prev) => ({
      ...prev,
      [employeeId]: !prev[employeeId],
    }));
  };

  // Làm mới đồng thời cả dữ liệu tổng quan và các truy vấn chi tiết block đã mở của kỳ hiện tại
  const handleRefreshPreview = async () => {
    await Promise.all([
      refetchPreview(),
      qc.invalidateQueries({
        queryKey: ['payroll-preview-detail', user?.id, selectedPeriodId],
      }),
    ]);
  };

  // 5. Chuyển trạng thái kỳ lương: gọi RPC approve_timesheet để khóa dữ liệu và lưu snapshot
  const approveMut = useMutation({
    mutationFn: async (periodId: string) => {
      if (!isAdmin) throw new Error('Chỉ quản trị viên mới có quyền duyệt bảng công.');
      const { error } = await supabase.rpc('approve_timesheet', {
        p_period_id: periodId,
      });
      if (error) throw error;
    },
    onSuccess: async (_, approvedPeriodId) => {
      setIsConfirmModalOpen(false);
      setErrMessage('');
      setOrphanedPunches([]);
      const periodLabel = selectedPeriod
        ? `Tháng ${String(selectedPeriod.month).padStart(2, '0')}/${selectedPeriod.year}`
        : '';
      setSuccessMessage(
        `Đã duyệt và chốt bảng lương ${periodLabel} thành công. Dữ liệu chấm công và phụ cấp trong kỳ đã được khóa.`
      );

      await Promise.all([
        qc.invalidateQueries({ queryKey: periodsKey }),
        qc.invalidateQueries({ queryKey: ['payroll-preview', user?.id, approvedPeriodId] }),
        qc.invalidateQueries({ queryKey: ['payroll-preview-detail', user?.id, approvedPeriodId] }),
        qc.invalidateQueries({ queryKey: ['monthly-allowances', user?.id, approvedPeriodId] }),
      ]);

      // Điều hướng sang /admin/payroll/view nếu route đã được đăng ký trong router tree
      const routerRecord = router as unknown as Record<string, unknown>;
      const routesByPath = isRecord(routerRecord.routesByPath) ? routerRecord.routesByPath : null;
      if (routesByPath && '/admin/payroll/view' in routesByPath) {
        router.navigate({ to: '/admin/payroll/view' as never });
      }
    },
    onError: (err: unknown) => {
      setIsConfirmModalOpen(false);
      setSuccessMessage('');
      const parsed = parseOrphanedPunchesError(err);
      setErrMessage(parsed.rawMessage);
      setOrphanedPunches(parsed.orphans);
    },
  });

  if (!isAdmin) {
    return <div className="p-4 text-red-600">Bạn không có quyền truy cập phân hệ này.</div>;
  }

  if (periodsLoading || employeesLoading) {
    return <div className="p-4 text-gray-600">Đang tải danh sách kỳ lương và hồ sơ nhân viên...</div>;
  }

  const initError = periodsError || employeesError;
  if (initError) {
    const initErrMsg = initError instanceof Error ? initError.message : String(initError);
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
        Lỗi tải dữ liệu hệ thống: {initErrMsg}
      </div>
    );
  }

  const parsedPreviewErr = previewError ? parseOrphanedPunchesError(previewError) : null;

  return (
    <div className="space-y-6">
      {/* Thanh chọn kỳ lương và nút Duyệt bảng công */}
      <div className="bg-white border border-gray-200 rounded-lg p-4 shadow-sm flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <label htmlFor="payroll-period-select" className="text-sm font-semibold text-gray-700">
            Chọn kỳ lương:
          </label>
          {periods.length === 0 ? (
            <span className="text-sm text-gray-500">
              Chưa có kỳ lương nào. Vui lòng tạo tại mục{' '}
              <Link to="/admin/payroll/allowances" className="text-blue-600 hover:underline">
                Kỳ lương & Phụ cấp
              </Link>
              .
            </span>
          ) : (
            <select
              id="payroll-period-select"
              value={selectedPeriodId}
              onChange={(e) => {
                setSelectedPeriodId(e.target.value);
                setExpandedEmployees({});
                setErrMessage('');
                setOrphanedPunches([]);
                setSuccessMessage('');
              }}
              className="border border-gray-300 rounded-md px-3 py-2 text-sm bg-white font-medium text-gray-800"
            >
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  Tháng {String(p.month).padStart(2, '0')}/{p.year} —{' '}
                  {p.status === 'open' ? 'Đang mở (Open)' : 'Đã duyệt (Approved)'}
                </option>
              ))}
            </select>
          )}

          {selectedPeriod && (
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-semibold ${
                isPeriodOpen ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-800'
              }`}
            >
              {isPeriodOpen ? 'Đang mở — Tạm tính' : 'Đã duyệt — Đã khóa sổ'}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {isPeriodOpen && selectedPeriod && (
            <>
              <button
                type="button"
                onClick={handleRefreshPreview}
                disabled={previewLoading || approveMut.isPending}
                className="px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                Làm mới tạm tính
              </button>
              <button
                type="button"
                onClick={() => {
                  setErrMessage('');
                  setOrphanedPunches([]);
                  setIsConfirmModalOpen(true);
                }}
                disabled={approveMut.isPending || previewLoading || !!previewError}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-semibold shadow-sm disabled:opacity-50"
              >
                {approveMut.isPending ? 'Đang duyệt...' : 'Duyệt bảng công'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Thông báo duyệt thành công */}
      {successMessage && (
        <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm">
          {successMessage}
        </div>
      )}

      {/* Hiển thị lỗi khi gọi approve_timesheet và bảng chi tiết các nhân viên bị treo ca (ORPHANED_PUNCHES) */}
      {errMessage && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg space-y-3">
          <div className="text-sm font-semibold text-red-800">{errMessage}</div>
          {orphanedPunches.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-red-700">
                Vui lòng kiểm tra và chỉnh sửa hoặc bổ sung dữ liệu chấm công cho các nhân viên dưới đây tại mục{' '}
                <Link to="/admin/punches" className="underline font-semibold">
                  Dữ liệu chấm công
                </Link>{' '}
                trước khi duyệt lại kỳ lương:
              </p>
              <div className="overflow-x-auto bg-white rounded border border-red-200">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-red-100 text-red-900 border-b border-red-200">
                      <th className="p-2 border-r border-red-200">Mã NV</th>
                      <th className="p-2 border-r border-red-200">Họ và tên</th>
                      <th className="p-2 border-r border-red-200">Trạng thái treo cuối cùng</th>
                      <th className="p-2">Thời điểm ghi nhận (Giờ VN)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orphanedPunches.map((item, idx) => (
                      <tr key={`${item.employee_id}-${idx}`} className="border-b border-red-100">
                        <td className="p-2 border-r border-red-100 font-mono font-semibold">
                          {item.employee_code}
                        </td>
                        <td className="p-2 border-r border-red-100">{item.full_name}</td>
                        <td className="p-2 border-r border-red-100 text-red-700 font-medium">
                          {formatPunchTypeLabel(item.last_type)}
                        </td>
                        <td className="p-2">
                          {item.last_punch_at
                            ? formatTimestamptzVN(item.last_punch_at)
                            : 'Không có giờ vào ca'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Nội dung chính theo trạng thái kỳ lương */}
      {!selectedPeriod ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-sm text-gray-500">
          Vui lòng chọn một kỳ lương để xem trước hoặc duyệt bảng công.
        </div>
      ) : !isPeriodOpen ? (
        <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm space-y-2">
          <h3 className="text-base font-bold text-gray-800">
            Kỳ lương Tháng {String(selectedPeriod.month).padStart(2, '0')}/{selectedPeriod.year} đã được duyệt
          </h3>
          <p className="text-sm text-gray-600">
            Kỳ lương này đã chốt sổ
            {selectedPeriod.approved_at
              ? ` vào lúc ${formatTimestamptzVN(selectedPeriod.approved_at)}`
              : ''}
            . Chế độ xem trước tạm tính (preview_timesheet) chỉ áp dụng cho kỳ lương đang mở. Toàn bộ dữ liệu chấm công và phụ cấp của kỳ này đã được khóa và lưu bản chụp cố định (snapshot).
          </p>
        </div>
      ) : parsedPreviewErr ? (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg space-y-3">
          <div className="text-sm font-semibold text-red-800">
            {parsedPreviewErr.isOrphanError
              ? parsedPreviewErr.rawMessage
              : `Lỗi khi gọi tính năng xem trước bảng lương: ${parsedPreviewErr.rawMessage}`}
          </div>
          {parsedPreviewErr.orphans.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-red-700">
                Hệ thống phát hiện dữ liệu chấm công chưa đóng ca hoặc sai trình tự. Vui lòng xử lý tại mục{' '}
                <Link to="/admin/punches" className="underline font-semibold">
                  Dữ liệu chấm công
                </Link>{' '}
                để xem trước và duyệt bảng lương:
              </p>
              <div className="overflow-x-auto bg-white rounded border border-red-200">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-red-100 text-red-900 border-b border-red-200">
                      <th className="p-2 border-r border-red-200">Mã NV</th>
                      <th className="p-2 border-r border-red-200">Họ và tên</th>
                      <th className="p-2 border-r border-red-200">Trạng thái treo cuối cùng</th>
                      <th className="p-2">Thời điểm ghi nhận (Giờ VN)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsedPreviewErr.orphans.map((item, idx) => (
                      <tr key={`${item.employee_id}-${idx}`} className="border-b border-red-100">
                        <td className="p-2 border-r border-red-100 font-mono font-semibold">
                          {item.employee_code}
                        </td>
                        <td className="p-2 border-r border-red-100">{item.full_name}</td>
                        <td className="p-2 border-r border-red-100 text-red-700 font-medium">
                          {formatPunchTypeLabel(item.last_type)}
                        </td>
                        <td className="p-2">
                          {item.last_punch_at
                            ? formatTimestamptzVN(item.last_punch_at)
                            : 'Không có giờ vào ca'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      ) : previewLoading ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-sm text-gray-600">
          Đang tổng hợp dữ liệu tạm tính từ máy chủ...
        </div>
      ) : sortedPreviewRows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-sm text-gray-500">
          Chưa có dữ liệu công đã đóng phiên hoặc phụ cấp nào phát sinh trong kỳ lương Tháng{' '}
          {String(selectedPeriod.month).padStart(2, '0')}/{selectedPeriod.year}.
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gray-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-gray-50">
            <div>
              <h3 className="text-base font-bold text-gray-800">
                Bảng lương tạm tính — Tháng {String(selectedPeriod.month).padStart(2, '0')}/
                {selectedPeriod.year}
              </h3>
              <p className="text-xs text-gray-500">
                Số liệu tổng hợp trực tiếp từ cơ sở dữ liệu theo 6 nhóm phút công, đơn giá giờ, tiền giờ tạm tính, phụ cấp và chi tiết từng block 15 phút.
              </p>
            </div>
            <div className="text-xs text-gray-600 font-medium">
              Tổng số nhân sự: <span className="font-bold text-gray-900">{sortedPreviewRows.length}</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="bg-gray-100 border-b border-gray-200 text-gray-700">
                  <th className="p-2.5 border-r border-gray-200">Nhân viên</th>
                  <th className="p-2.5 border-r border-gray-200 text-right">Đơn giá giờ</th>
                  <th className="p-2.5 border-r border-gray-200 text-right">Thường ngày (1.0x)</th>
                  <th className="p-2.5 border-r border-gray-200 text-right">Thường đêm (1.3x)</th>
                  <th className="p-2.5 border-r border-gray-200 text-right">Tăng ca ngày (1.5x)</th>
                  <th className="p-2.5 border-r border-gray-200 text-right">Tăng ca đêm (1.8x)</th>
                  <th className="p-2.5 border-r border-gray-200 text-right">Lễ ngày (2.0x)</th>
                  <th className="p-2.5 border-r border-gray-200 text-right">Lễ đêm (2.3x)</th>
                  <th className="p-2.5 border-r border-gray-200 text-right bg-emerald-50/60 text-emerald-900">
                    Tiền giờ tạm tính
                  </th>
                  <th className="p-2.5 border-r border-gray-200 text-right">Phụ cấp cố định</th>
                  <th className="p-2.5 border-r border-gray-200 text-right">Phụ cấp tháng</th>
                  <th className="p-2.5 text-right bg-blue-50 text-blue-900">Tổng lương tạm tính</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {sortedPreviewRows.map((row) => {
                  const emp = employeeMap.get(row.employee_id);
                  const empCode = emp?.employee_code ?? row.employee_id;
                  const empName = emp?.full_name ?? 'Nhân viên không xác định';
                  const empAllowances = allowancesByEmployee.get(row.employee_id) ?? [];
                  const isExpanded = Boolean(expandedEmployees[row.employee_id]);

                  const regDay = formatMinutesAndHours(row.minutes_regular_day);
                  const regNight = formatMinutesAndHours(row.minutes_regular_night);
                  const otDay = formatMinutesAndHours(row.minutes_ot_day);
                  const otNight = formatMinutesAndHours(row.minutes_ot_night);
                  const holDay = formatMinutesAndHours(row.minutes_holiday_day);
                  const holNight = formatMinutesAndHours(row.minutes_holiday_night);

                  const totalPaidMinutes =
                    row.minutes_regular_day +
                    row.minutes_regular_night +
                    row.minutes_ot_day +
                    row.minutes_ot_night +
                    row.minutes_holiday_day +
                    row.minutes_holiday_night;
                  const totalPaidBlocks = Math.round(totalPaidMinutes / 15);

                  return (
                    <Fragment key={row.employee_id}>
                      <tr className="hover:bg-gray-50 align-top">
                        <td className="p-2.5 border-r border-gray-200 min-w-[180px]">
                          <div className="font-mono font-bold text-gray-900">{empCode}</div>
                          <div className="text-gray-700 font-medium">{empName}</div>
                          <button
                            type="button"
                            onClick={() => toggleEmployeeDetails(row.employee_id)}
                            aria-expanded={isExpanded}
                            className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-300 bg-white hover:bg-gray-100 text-[11px] font-medium text-gray-700"
                          >
                            <span>{isExpanded ? '▾ Ẩn chi tiết block' : '▸ Xem chi tiết block'}</span>
                            <span className="text-gray-500">({totalPaidBlocks} block)</span>
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
                        <td className="p-2.5 border-r border-gray-200 text-right font-semibold text-emerald-900 bg-emerald-50/30 whitespace-nowrap">
                          {formatVND(row.hourly_pay_subtotal)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right font-medium text-gray-800 whitespace-nowrap">
                          {formatVND(row.fixed_allowance_snapshot)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right">
                          <div className="font-medium text-gray-800 whitespace-nowrap">
                            {formatVND(row.total_allowance)}
                          </div>
                          {empAllowances.length > 0 && (
                            <ul className="mt-1 space-y-0.5 text-[11px] text-gray-500 text-right">
                              {empAllowances.map((al) => (
                                <li key={al.id}>
                                  {al.reason || 'Phụ cấp'}: {formatVND(al.amount)}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td className="p-2.5 text-right font-bold text-blue-900 bg-blue-50/40 whitespace-nowrap text-sm">
                          {formatVND(row.total_salary)}
                        </td>
                      </tr>

                      {/* Hàng mở rộng: gọi lazy-load preview_timesheet({ p_period_id, p_employee_id }) cho đúng nhân viên đang mở */}
                      {isExpanded && (
                        <tr className="bg-slate-50/80">
                          <td colSpan={12} className="p-3 sm:p-4 border-t border-gray-200">
                            <EmployeeBlockDetailsSection
                              userId={user?.id}
                              isAdmin={isAdmin}
                              periodId={selectedPeriodId}
                              isPeriodOpen={isPeriodOpen}
                              employeeId={row.employee_id}
                              empCode={empCode}
                              empName={empName}
                              isExpanded={isExpanded}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Hộp thoại xác nhận duyệt bảng công (không thể hoàn tác) */}
      {isConfirmModalOpen && selectedPeriod && isPeriodOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="approve-payroll-modal-title"
          aria-describedby="approve-payroll-modal-desc"
        >
          <div className="bg-white rounded-lg max-w-md w-full p-6 shadow-xl border border-gray-200 space-y-4">
            <h4 id="approve-payroll-modal-title" className="text-lg font-bold text-gray-900">
              Xác nhận duyệt bảng công Tháng {String(selectedPeriod.month).padStart(2, '0')}/
              {selectedPeriod.year}
            </h4>
            <div id="approve-payroll-modal-desc" className="text-sm text-gray-700 space-y-2">
              <p className="font-semibold text-amber-800 bg-amber-50 border border-amber-200 p-3 rounded">
                Cảnh báo: Thao tác này không thể hoàn tác!
              </p>
              <ul className="list-disc pl-5 space-y-1 text-xs text-gray-600">
                <li>
                  Hệ thống sẽ lưu cố định (snapshot) đơn giá lương theo giờ, phụ cấp cố định, tổng phút công và thành tiền của từng nhân viên.
                </li>
                <li>
                  Toàn bộ dữ liệu chấm công (punches) và phụ cấp hàng tháng (monthly_allowances) trong kỳ lương này sẽ bị khóa vĩnh viễn ở tầng cơ sở dữ liệu.
                </li>
                <li>
                  Nếu còn bất kỳ nhân viên nào chưa kết thúc phiên làm việc/nghỉ giữa ca, hệ thống sẽ từ chối duyệt và liệt kê danh sách cần xử lý.
                </li>
              </ul>
            </div>
            <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-200">
              <button
                type="button"
                disabled={approveMut.isPending}
                onClick={() => setIsConfirmModalOpen(false)}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-50"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                disabled={approveMut.isPending}
                onClick={() => approveMut.mutate(selectedPeriod.id)}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm font-semibold disabled:opacity-50"
              >
                {approveMut.isPending ? 'Đang xử lý...' : 'Xác nhận duyệt & khóa sổ'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
