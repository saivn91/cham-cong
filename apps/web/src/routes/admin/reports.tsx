import { useState, useEffect, useMemo } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { Database } from '@timekeeping/shared/database.types';
import { useAuth } from '../../lib/auth-context';
import { supabase } from '../../lib/supabase';
import {
  exportPayrollWorkbook,
  exportTimesheetWorkbook,
  type PayrollWorkbookRowInput,
  type PayrollMonthlyAllowanceItem,
  type TimesheetWorkbookRowInput,
} from '../../lib/reports/export-workbook';

export const Route = createFileRoute('/admin/reports')({
  component: AdminReportsPage,
});

type ReportMode = 'payroll' | 'timesheet';

type ApprovedPayrollPeriod = Pick<
  Database['public']['Tables']['payroll_periods']['Row'],
  'id' | 'year' | 'month' | 'status' | 'approved_at'
>;

type PayrollRow = Database['public']['Tables']['payroll']['Row'];

type EmployeeProfile = Pick<
  Database['public']['Tables']['employees']['Row'],
  'id' | 'employee_code' | 'full_name' | 'is_active' | 'role'
>;

type BranchRow = Pick<
  Database['public']['Tables']['branches']['Row'],
  'id' | 'code' | 'name'
>;

type PunchRow = Pick<
  Database['public']['Tables']['punches']['Row'],
  'id' | 'employee_id' | 'branch_id' | 'type' | 'at' | 'voided_at'
>;

type HolidayRow = Pick<
  Database['public']['Tables']['holidays']['Row'],
  'date' | 'name'
>;

type MonthlyAllowanceRow = Pick<
  Database['public']['Tables']['monthly_allowances']['Row'],
  'id' | 'period_id' | 'employee_id' | 'amount' | 'reason'
>;

const vndFormatter = new Intl.NumberFormat('vi-VN');
const hourFormatter = new Intl.NumberFormat('vi-VN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function formatVND(amount: number): string {
  return `${vndFormatter.format(Math.round(Number(amount) || 0))} ₫`;
}

function formatMinutes(mins: number): string {
  const safe = Number(mins) || 0;
  return vndFormatter.format(safe);
}

function formatHours(hours: number): string {
  const safe = Number.isFinite(hours) ? hours : 0;
  return hourFormatter.format(safe);
}

// Chuyển đổi epoch ms sang ngày YYYY-MM-DD theo múi giờ Việt Nam (UTC+7)
function toVietnamDateString(epochMs: number): string {
  const vnDate = new Date(epochMs + VN_OFFSET_MS);
  const y = vnDate.getUTCFullYear();
  const m = String(vnDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(vnDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Xác định ngày Thứ Hai đầu tuần (YYYY-MM-DD) theo múi giờ Việt Nam của mốc thời gian
function getVietnamMondayDateString(epochMs: number): string {
  const vnDate = new Date(epochMs + VN_OFFSET_MS);
  const dayOfWeek = vnDate.getUTCDay(); // 0 = CN, 1 = T2, ..., 6 = T7
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const mondayEpoch = epochMs + diffToMonday * DAY_MS;
  return toVietnamDateString(mondayEpoch);
}

// Tính mốc đầu tháng, cuối tháng và khoảng lookback đầu tuần (Thứ Hai giờ VN của tuần chứa ngày 01)
// để tích lũy đúng ngưỡng 48 giờ/tuần cho tuần giao thoa đầu tháng mà không kết xuất trùng các ca tháng trước.
function getVietnamMonthBounds(year: number, month: number): {
  startIso: string;
  endIso: string;
  firstWeekMondayVn: string;
  lookbackStartIso: string;
  paddedEndIso: string;
  holidayStartDate: string;
  holidayEndDate: string;
  monthToken: string;
} {
  const pad = (n: number) => String(n).padStart(2, '0');
  const monthToken = `${year}-${pad(month)}`;
  const startIso = `${monthToken}-01T00:00:00+07:00`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const endIso = `${nextYear}-${pad(nextMonth)}-01T00:00:00+07:00`;

  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();

  // Tìm Thứ Hai (giờ VN) của tuần chứa ngày mùng 1 đầu tháng
  const firstWeekMondayVn = getVietnamMondayDateString(startMs);
  const firstWeekMondayStartMs = new Date(
    `${firstWeekMondayVn}T00:00:00+07:00`
  ).getTime();

  // Lùi thêm 24h trước 00:00 Thứ Hai đầu tuần để ghép đầy đủ ca nếu có và lấy trọn các ca từ Thứ Hai của tuần đầu tháng
  const lookbackStartMs = firstWeekMondayStartMs - DAY_MS;
  const lookbackStartIso = new Date(lookbackStartMs).toISOString();

  // Mở rộng biên cuối tháng +24h để đóng trọn vẹn các ca đêm bắt đầu (clock_in) vào ngày cuối tháng
  const paddedEndMs = endMs + DAY_MS;
  const paddedEndIso = new Date(paddedEndMs).toISOString();

  const holidayStartDate = toVietnamDateString(lookbackStartMs);
  const holidayEndDate = toVietnamDateString(paddedEndMs);

  return {
    startIso,
    endIso,
    firstWeekMondayVn,
    lookbackStartIso,
    paddedEndIso,
    holidayStartDate,
    holidayEndDate,
    monthToken,
  };
}

// Tính thành phần lương theo giờ chỉ phục vụ hiển thị (derived) từ đơn giá snapshot và 6 nhóm số phút đã duyệt.
// Tuyệt đối không ghi đè hay thay đổi total_salary đã chốt trong bảng payroll.
function deriveHourlyPaySubtotalFromSnapshot(row: PayrollRow): number {
  const rate = Number(row.hourly_rate_snapshot) || 0;
  const weightedHours =
    ((Number(row.minutes_regular_day) || 0) / 60) * 1.0 +
    ((Number(row.minutes_regular_night) || 0) / 60) * 1.3 +
    ((Number(row.minutes_ot_day) || 0) / 60) * 1.5 +
    ((Number(row.minutes_ot_night) || 0) / 60) * 1.8 +
    ((Number(row.minutes_holiday_day) || 0) / 60) * 2.0 +
    ((Number(row.minutes_holiday_night) || 0) / 60) * 2.3;
  return Math.round(weightedHours * rate);
}

interface ValidatedBreakInterval {
  startMs: number;
  endMs: number;
}

interface ParsedTimesheetSession {
  employeeId: string;
  branchId: string;
  clockInMs: number;
  clockOutMs: number | null;
  clockInDateVn: string;
  weekMondayVn: string;
  breaks: ValidatedBreakInterval[];
  warnings: string[];
  isComplete: boolean;
}

// Cắt một khoảng thời gian [startMs, endMs] theo ranh giới từng ngày lịch Việt Nam (00:00+07:00)
function splitIntervalByVietnamDays(
  startMs: number,
  endMs: number
): Array<{ dateVn: string; sliceStartMs: number; sliceEndMs: number; minutes: number }> {
  const result: Array<{
    dateVn: string;
    sliceStartMs: number;
    sliceEndMs: number;
    minutes: number;
  }> = [];

  if (endMs <= startMs) return result;

  let cursor = startMs;
  while (cursor < endMs) {
    const dateVn = toVietnamDateString(cursor);
    const nextDayStartMs = new Date(`${dateVn}T00:00:00+07:00`).getTime() + DAY_MS;
    const sliceEnd = Math.min(endMs, nextDayStartMs);
    const minutes = Math.max(0, (sliceEnd - cursor) / 60000);
    if (minutes > 0) {
      result.push({
        dateVn,
        sliceStartMs: cursor,
        sliceEndMs: sliceEnd,
        minutes,
      });
    }
    cursor = sliceEnd;
  }

  return result;
}

// Tính số phút thực tế không làm tròn trong một phiên làm việc hợp lệ, có tách phần ngày thường và phần ngày lễ
function computeSessionNetMinutesByHoliday(
  session: ParsedTimesheetSession,
  holidayDateSet: ReadonlySet<string>
): { nonHolidayMinutes: number; holidayMinutes: number; totalNetMinutes: number } {
  if (!session.isComplete || session.clockOutMs === null || session.clockOutMs <= session.clockInMs) {
    return { nonHolidayMinutes: 0, holidayMinutes: 0, totalNetMinutes: 0 };
  }

  const daySlices = splitIntervalByVietnamDays(session.clockInMs, session.clockOutMs);
  let nonHolidayMinutes = 0;
  let holidayMinutes = 0;

  for (const slice of daySlices) {
    let breakOverlapMs = 0;
    for (const brk of session.breaks) {
      const overlapStart = Math.max(slice.sliceStartMs, brk.startMs);
      const overlapEnd = Math.min(slice.sliceEndMs, brk.endMs);
      if (overlapEnd > overlapStart) {
        breakOverlapMs += overlapEnd - overlapStart;
      }
    }
    const netMs = Math.max(0, slice.sliceEndMs - slice.sliceStartMs - breakOverlapMs);
    const netMins = netMs / 60000;
    if (holidayDateSet.has(slice.dateVn)) {
      holidayMinutes += netMins;
    } else {
      nonHolidayMinutes += netMins;
    }
  }

  return {
    nonHolidayMinutes,
    holidayMinutes,
    totalNetMinutes: nonHolidayMinutes + holidayMinutes,
  };
}

// Phân tích chuỗi sự kiện chấm công của từng nhân viên theo đúng state machine:
// clock_in -> (break_start -> break_end)* -> clock_out
// Các bất biến nghiệp vụ bắt buộc:
// 1. Không lọc branch_id trên từng punch rời rạc trước khi ghép ca để tránh cắt đứt clock_out/break khi nhân viên chấm khác chi nhánh;
//    sau khi ghép ca hoàn chỉnh mới lọc theo chi nhánh của sự kiện mở đầu phiên (session.branchId).
// 2. Với tuần đầu tháng bị vắt qua tháng trước: các phiên có clock_in từ Thứ Hai đầu tuần đó thuộc tháng trước vẫn được tính vào
//    ngưỡng 48 giờ/tuần, nhưng KHÔNG được xuất lặp lại trong danh sách dòng công của tháng đang chọn.
// 3. work_hours phản ánh toàn bộ tổng giờ làm thực tế ròng (nonHolidayMinutes + holidayMinutes), còn overtime_hours là phần vượt 48h/tuần.
// 4. Mọi phiên sai trình tự thời gian, thiếu sự kiện đóng hoặc mồ côi đều giữ isComplete = false (0 giờ công) và hiển thị cảnh báo rõ ràng.
function buildTimesheetRowsFromPunches(params: {
  punches: readonly PunchRow[];
  holidayDateSet: ReadonlySet<string>;
  targetMonthToken: string;
  firstWeekMondayVn: string;
  monthStartMs: number;
  monthEndMs: number;
  selectedBranchId: string;
  employeeMap: ReadonlyMap<string, EmployeeProfile>;
  branchMap: ReadonlyMap<string, BranchRow>;
}): TimesheetWorkbookRowInput[] {
  const {
    punches,
    holidayDateSet,
    targetMonthToken,
    firstWeekMondayVn,
    monthStartMs,
    monthEndMs,
    selectedBranchId,
    employeeMap,
    branchMap,
  } = params;

  const punchesByEmployee = new Map<string, PunchRow[]>();
  for (const p of punches) {
    if (p.voided_at !== null) continue;
    const list = punchesByEmployee.get(p.employee_id);
    if (list) {
      list.push(p);
    } else {
      punchesByEmployee.set(p.employee_id, [p]);
    }
  }

  const allSessions: ParsedTimesheetSession[] = [];

  for (const [employeeId, empPunches] of punchesByEmployee.entries()) {
    const sorted = [...empPunches].sort((a, b) => {
      const tA = new Date(a.at).getTime();
      const tB = new Date(b.at).getTime();
      if (Number.isFinite(tA) && Number.isFinite(tB) && tA !== tB) {
        return tA - tB;
      }
      return a.id.localeCompare(b.id);
    });

    let currentSession: ParsedTimesheetSession | null = null;
    let openBreakStartMs: number | null = null;
    let lastEventMs: number | null = null;

    const addUniqueWarning = (session: ParsedTimesheetSession, msg: string) => {
      if (!session.warnings.includes(msg)) {
        session.warnings.push(msg);
      }
    };

    const finalizeIncompleteSession = (reason: string) => {
      if (!currentSession) return;
      addUniqueWarning(currentSession, reason);
      currentSession.isComplete = false;
      allSessions.push(currentSession);
      currentSession = null;
      openBreakStartMs = null;
      lastEventMs = null;
    };

    for (const ev of sorted) {
      const parsedMs = new Date(ev.at).getTime();
      if (!Number.isFinite(parsedMs)) {
        // Nếu thời gian sự kiện không hợp lệ (NaN), đánh dấu phiên hiện tại không hoàn chỉnh hoặc tạo dòng cảnh báo
        if (currentSession !== null) {
          finalizeIncompleteSession(`Dữ liệu thời gian lượt chấm (${ev.type}) không hợp lệ`);
        } else {
          const fallbackDateVn = `${targetMonthToken}-01`;
          allSessions.push({
            employeeId,
            branchId: ev.branch_id,
            clockInMs: monthStartMs,
            clockOutMs: null,
            clockInDateVn: fallbackDateVn,
            weekMondayVn: getVietnamMondayDateString(monthStartMs),
            breaks: [],
            warnings: [`Dữ liệu thời gian lượt chấm (${ev.type}) không hợp lệ`],
            isComplete: false,
          });
        }
        continue;
      }

      const evMs = parsedMs;
      const evDateVn = toVietnamDateString(evMs);

      if (ev.type === 'clock_in') {
        if (currentSession !== null) {
          finalizeIncompleteSession(
            openBreakStartMs !== null
              ? 'Thiếu kết thúc nghỉ (break_end) và ra ca (clock_out) trước khi vào ca mới'
              : 'Thiếu lượt ra ca (clock_out) trước khi vào ca mới'
          );
        }
        currentSession = {
          employeeId,
          branchId: ev.branch_id,
          clockInMs: evMs,
          clockOutMs: null,
          clockInDateVn: evDateVn,
          weekMondayVn: getVietnamMondayDateString(evMs),
          breaks: [],
          warnings: [],
          isComplete: false,
        };
        openBreakStartMs = null;
        lastEventMs = evMs;
        continue;
      }

      if (currentSession === null) {
        // Sự kiện mồ côi đứng độc lập mà không có clock_in mở trước đó.
        // Lưu ý: bỏ qua clock_out/break_end ở sát ranh giới đầu lookback do ca của tuần trước nữa đóng muộn,
        // nhưng mọi sự kiện mồ côi phát sinh trong phạm vi tháng đang báo cáo bắt buộc phải giữ lại để hiển thị cảnh báo.
        if (evMs >= monthStartMs && evMs < monthEndMs) {
          allSessions.push({
            employeeId,
            branchId: ev.branch_id,
            clockInMs: evMs,
            clockOutMs: null,
            clockInDateVn: evDateVn,
            weekMondayVn: getVietnamMondayDateString(evMs),
            breaks: [],
            warnings: [`Lượt chấm ${ev.type} mồ côi (thiếu clock_in)`],
            isComplete: false,
          });
        }
        continue;
      }

      if (lastEventMs !== null && evMs <= lastEventMs) {
        addUniqueWarning(
          currentSession,
          'Thứ tự thời gian lượt chấm không tăng nghiêm ngặt'
        );
      }
      lastEventMs = evMs;

      if (ev.type === 'break_start') {
        if (openBreakStartMs !== null) {
          addUniqueWarning(
            currentSession,
            'Bắt đầu nghỉ (break_start) lặp khi chưa kết thúc nghỉ trước đó'
          );
        } else {
          openBreakStartMs = evMs;
        }
        continue;
      }

      if (ev.type === 'break_end') {
        if (openBreakStartMs === null) {
          addUniqueWarning(
            currentSession,
            'Kết thúc nghỉ (break_end) nhưng thiếu break_start'
          );
        } else if (evMs <= openBreakStartMs) {
          addUniqueWarning(
            currentSession,
            'Thời gian kết thúc nghỉ không hợp lệ (<= break_start)'
          );
          openBreakStartMs = null;
        } else {
          currentSession.breaks.push({ startMs: openBreakStartMs, endMs: evMs });
          openBreakStartMs = null;
        }
        continue;
      }

      if (ev.type === 'clock_out') {
        if (openBreakStartMs !== null) {
          addUniqueWarning(
            currentSession,
            'Ra ca (clock_out) khi chưa kết thúc nghỉ giữa ca (thiếu break_end)'
          );
          currentSession.isComplete = false;
          currentSession.clockOutMs = evMs;
          allSessions.push(currentSession);
          currentSession = null;
          openBreakStartMs = null;
          lastEventMs = null;
          continue;
        }

        const totalDurationMs = evMs - currentSession.clockInMs;
        if (totalDurationMs <= 0) {
          addUniqueWarning(currentSession, 'Giờ ra ca không lớn hơn giờ vào ca');
          currentSession.isComplete = false;
        } else if (totalDurationMs > DAY_MS) {
          addUniqueWarning(currentSession, 'Phiên làm việc kéo dài quá 24 giờ');
          currentSession.isComplete = false;
        } else if (currentSession.warnings.length === 0) {
          currentSession.isComplete = true;
        } else {
          currentSession.isComplete = false;
        }

        currentSession.clockOutMs = evMs;
        allSessions.push(currentSession);
        currentSession = null;
        openBreakStartMs = null;
        lastEventMs = null;
      }
    }

    if (currentSession !== null) {
      finalizeIncompleteSession(
        openBreakStartMs !== null
          ? 'Ca đang mở: thiếu break_end và clock_out'
          : 'Ca đang mở: thiếu lượt ra ca (clock_out)'
      );
    }
  }

  // Giữ lại các phiên thuộc tháng mục tiêu VÀ các phiên thuộc tháng trước nhưng nằm trong cùng tuần Thứ Hai đầu tháng
  // để tích lũy chính xác ngưỡng 48 giờ/tuần cho tuần đầu tiên của tháng.
  const relevantSessions = allSessions.filter(
    (s) =>
      s.clockInDateVn.startsWith(targetMonthToken) ||
      (s.weekMondayVn === firstWeekMondayVn && s.clockInDateVn >= firstWeekMondayVn)
  );

  // Gom theo nhân viên + tuần (Thứ Hai giờ VN)
  const sessionsByEmpWeek = new Map<string, ParsedTimesheetSession[]>();
  for (const s of relevantSessions) {
    const key = `${s.employeeId}__${s.weekMondayVn}`;
    const group = sessionsByEmpWeek.get(key);
    if (group) {
      group.push(s);
    } else {
      sessionsByEmpWeek.set(key, [s]);
    }
  }

  interface DailyAccumulator {
    employeeId: string;
    dateVn: string;
    branchIds: Set<string>;
    workMinutes: number;
    overtimeMinutes: number;
    sessionCount: number;
    warnings: Set<string>;
    hasHolidayWork: boolean;
  }

  const dailyMap = new Map<string, DailyAccumulator>();
  const WEEKLY_REGULAR_THRESHOLD_MINS = 48 * 60; // 2880 phút công ngày thường/tuần

  for (const weekSessions of sessionsByEmpWeek.values()) {
    weekSessions.sort((a, b) => a.clockInMs - b.clockInMs);
    let weeklyNonHolidayRegularUsedMins = 0;

    for (const s of weekSessions) {
      let sessionTotalNetMins = 0;
      let sessionOtNonHolidayMins = 0;
      let sessionHolidayMins = 0;

      // Bước 1: Luôn cập nhật lũy kế 48 giờ/tuần trên mọi phiên hợp lệ của nhân viên trong tuần đó
      // (kể cả phiên ở đầu tuần thuộc tháng trước hoặc phiên ở chi nhánh khác)
      if (s.isComplete) {
        const { nonHolidayMinutes, holidayMinutes, totalNetMinutes } =
          computeSessionNetMinutesByHoliday(s, holidayDateSet);

        const remainingRegularCap = Math.max(
          0,
          WEEKLY_REGULAR_THRESHOLD_MINS - weeklyNonHolidayRegularUsedMins
        );
        const regularNonHoliday = Math.min(nonHolidayMinutes, remainingRegularCap);
        sessionOtNonHolidayMins = Math.max(0, nonHolidayMinutes - regularNonHoliday);
        weeklyNonHolidayRegularUsedMins += nonHolidayMinutes;

        sessionTotalNetMins = totalNetMinutes;
        sessionHolidayMins = holidayMinutes;
      }

      // Bước 2: Chỉ kết xuất ra báo cáo các phiên có ngày clock_in thuộc đúng tháng mục tiêu
      // (các phiên của tháng trước trong tuần giao thoa chỉ dùng để tính ngưỡng 48h, không xuất/trả lương lặp lại)
      if (!s.clockInDateVn.startsWith(targetMonthToken)) {
        continue;
      }

      // Bước 3: Áp dụng bộ lọc chi nhánh dựa trên chi nhánh mở phiên (clock_in branch) sau khi đã ghép trọn phiên
      if (selectedBranchId !== 'ALL' && s.branchId !== selectedBranchId) {
        continue;
      }

      const dayKey = `${s.employeeId}__${s.clockInDateVn}`;
      let acc = dailyMap.get(dayKey);
      if (!acc) {
        acc = {
          employeeId: s.employeeId,
          dateVn: s.clockInDateVn,
          branchIds: new Set<string>(),
          workMinutes: 0,
          overtimeMinutes: 0,
          sessionCount: 0,
          warnings: new Set<string>(),
          hasHolidayWork: false,
        };
        dailyMap.set(dayKey, acc);
      }

      acc.branchIds.add(s.branchId);
      acc.sessionCount += 1;

      for (const w of s.warnings) {
        acc.warnings.add(w);
      }

      if (s.isComplete) {
        // Tổng giờ làm thực tế (work_hours) bao gồm toàn bộ giờ làm ròng (cả trong ngưỡng, vượt ngưỡng 48h và ngày lễ);
        // overtime_hours được báo cáo riêng như một tập con biểu thị phần vượt ngưỡng 48h/tuần.
        acc.workMinutes += sessionTotalNetMins;
        acc.overtimeMinutes += sessionOtNonHolidayMins;
        if (sessionHolidayMins > 0) {
          acc.hasHolidayWork = true;
        }
      }
    }
  }

  const rows: TimesheetWorkbookRowInput[] = [];

  for (const acc of dailyMap.values()) {
    const emp = employeeMap.get(acc.employeeId);
    const empCode = emp?.employee_code ?? acc.employeeId;
    const fullName = emp?.full_name ?? 'Nhân viên không xác định';

    const branchLabels = Array.from(acc.branchIds)
      .map((bId) => {
        const b = branchMap.get(bId);
        return b ? `${b.code} - ${b.name}` : bId;
      })
      .sort((a, b) => a.localeCompare(b));

    const statusParts: string[] = [];
    if (acc.warnings.size > 0) {
      statusParts.push(`Cảnh báo: ${Array.from(acc.warnings).join('; ')}`);
    } else if (acc.hasHolidayWork) {
      statusParts.push('Bình thường (Có giờ ngày lễ)');
    } else {
      statusParts.push('Bình thường');
    }

    rows.push({
      employee_code: empCode,
      full_name: fullName,
      branch_name: branchLabels.join(', ') || 'Chưa xác định',
      date: acc.dateVn,
      work_hours: Number((acc.workMinutes / 60).toFixed(2)),
      overtime_hours: Number((acc.overtimeMinutes / 60).toFixed(2)),
      session_count: acc.sessionCount,
      status: statusParts.join(' | '),
    });
  }

  rows.sort((a, b) => {
    const codeCompare = a.employee_code.localeCompare(b.employee_code);
    if (codeCompare !== 0) return codeCompare;
    return a.date.localeCompare(b.date);
  });

  return rows;
}

function AdminReportsPage() {
  const { user, role, loading: authLoading } = useAuth();
  const isAdmin = role === 'admin';

  const [reportMode, setReportMode] = useState<ReportMode>('payroll');
  const [selectedPeriodId, setSelectedPeriodId] = useState<string>('');
  const [selectedBranchId, setSelectedBranchId] = useState<string>('ALL');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('ALL');

  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportFeedback, setExportFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  // 1. Truy vấn danh sách kỳ lương đã duyệt (status = 'approved'), sắp xếp mới nhất trước
  const approvedPeriodsKey = ['reports-approved-periods', user?.id, role];
  const {
    data: approvedPeriods = [],
    isLoading: periodsLoading,
    error: periodsError,
    refetch: refetchPeriods,
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
    const first = approvedPeriods[0];
    if (!selectedPeriodId && first) {
      setSelectedPeriodId(first.id);
    }
  }, [approvedPeriods, selectedPeriodId]);

  const selectedPeriod = useMemo(
    () => approvedPeriods.find((p) => p.id === selectedPeriodId) ?? null,
    [approvedPeriods, selectedPeriodId]
  );

  // 2. Truy vấn danh mục chi nhánh và nhân viên
  const branchesKey = ['reports-branches', user?.id, role];
  const {
    data: branches = [],
    isLoading: branchesLoading,
    error: branchesError,
    refetch: refetchBranches,
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

  const branchMap = useMemo(() => {
    const map = new Map<string, BranchRow>();
    for (const b of branches) {
      map.set(b.id, b);
    }
    return map;
  }, [branches]);

  const employeesKey = ['reports-employees', user?.id, role];
  const {
    data: employees = [],
    isLoading: employeesLoading,
    error: employeesError,
    refetch: refetchEmployees,
  } = useQuery({
    queryKey: employeesKey,
    enabled: !!user && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select('id,employee_code,full_name,is_active,role')
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

  // 3. Truy vấn dữ liệu snapshot bảng lương đã duyệt (`payroll`)
  const payrollRowsKey = [
    'reports-payroll-rows',
    user?.id,
    selectedPeriodId,
    selectedEmployeeId,
  ];
  const {
    data: payrollRows = [],
    isLoading: payrollLoading,
    error: payrollError,
    refetch: refetchPayrollRows,
  } = useQuery({
    queryKey: payrollRowsKey,
    enabled: !!user && isAdmin && !!selectedPeriodId && reportMode === 'payroll',
    queryFn: async () => {
      let query = supabase
        .from('payroll')
        .select(
          'id,period_id,employee_id,hourly_rate_snapshot,fixed_allowance_snapshot,minutes_regular_day,minutes_regular_night,minutes_ot_day,minutes_ot_night,minutes_holiday_day,minutes_holiday_night,total_allowance,total_salary,calculated_at'
        )
        .eq('period_id', selectedPeriodId);

      if (selectedEmployeeId !== 'ALL') {
        query = query.eq('employee_id', selectedEmployeeId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as PayrollRow[];
    },
  });

  // 4. Truy vấn chi tiết các khoản phụ cấp phát sinh trong tháng (`monthly_allowances`) kèm lý do
  const allowancesKey = [
    'reports-monthly-allowances',
    user?.id,
    selectedPeriodId,
    selectedEmployeeId,
  ];
  const {
    data: monthlyAllowances = [],
    isLoading: allowancesLoading,
    error: allowancesError,
    refetch: refetchAllowances,
  } = useQuery({
    queryKey: allowancesKey,
    enabled: !!user && isAdmin && !!selectedPeriodId && reportMode === 'payroll',
    queryFn: async () => {
      let query = supabase
        .from('monthly_allowances')
        .select('id,period_id,employee_id,amount,reason')
        .eq('period_id', selectedPeriodId)
        .order('created_at', { ascending: true });

      if (selectedEmployeeId !== 'ALL') {
        query = query.eq('employee_id', selectedEmployeeId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as MonthlyAllowanceRow[];
    },
  });

  // 5. Truy vấn lượt chấm công trong tháng cho mục đích xác định tư cách thành viên chi nhánh của nhân viên (ở chế độ Bảng lương)
  const payrollBranchPunchesKey = [
    'reports-payroll-branch-punches',
    user?.id,
    selectedPeriod?.year,
    selectedPeriod?.month,
    selectedBranchId,
    selectedEmployeeId,
  ];
  const {
    data: payrollPeriodPunches = [],
    isLoading: payrollPunchesLoading,
    error: payrollPunchesError,
    refetch: refetchPayrollPunches,
  } = useQuery({
    queryKey: payrollBranchPunchesKey,
    enabled: !!user && isAdmin && !!selectedPeriod && reportMode === 'payroll',
    queryFn: async () => {
      if (!selectedPeriod) return [];
      const { startIso, endIso } = getVietnamMonthBounds(
        selectedPeriod.year,
        selectedPeriod.month
      );
      let query = supabase
        .from('punches')
        .select('id,employee_id,branch_id,type,at,voided_at')
        .is('voided_at', null)
        .gte('at', startIso)
        .lt('at', endIso);

      if (selectedBranchId !== 'ALL') {
        query = query.eq('branch_id', selectedBranchId);
      }
      if (selectedEmployeeId !== 'ALL') {
        query = query.eq('employee_id', selectedEmployeeId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as PunchRow[];
    },
  });

  // 6. Truy vấn toàn bộ dòng thời gian chấm công thực tế (bao gồm lookback về Thứ Hai đầu tuần của ngày 01 và +24h cuối tháng)
  // cho Báo cáo Bảng chấm công. Không lọc branch_id trong câu truy vấn DB để không làm gãy các phiên có clock_in/clock_out khác chi nhánh.
  const timesheetPunchesKey = [
    'reports-timesheet-punches',
    user?.id,
    selectedPeriod?.year,
    selectedPeriod?.month,
    selectedEmployeeId,
  ];
  const {
    data: timesheetPunches = [],
    isLoading: timesheetPunchesLoading,
    error: timesheetPunchesError,
    refetch: refetchTimesheetPunches,
  } = useQuery({
    queryKey: timesheetPunchesKey,
    enabled: !!user && isAdmin && !!selectedPeriod && reportMode === 'timesheet',
    queryFn: async () => {
      if (!selectedPeriod) return [];
      const { lookbackStartIso, paddedEndIso } = getVietnamMonthBounds(
        selectedPeriod.year,
        selectedPeriod.month
      );
      let query = supabase
        .from('punches')
        .select('id,employee_id,branch_id,type,at,voided_at')
        .is('voided_at', null)
        .gte('at', lookbackStartIso)
        .lte('at', paddedEndIso)
        .order('at', { ascending: true })
        .order('id', { ascending: true });

      if (selectedEmployeeId !== 'ALL') {
        query = query.eq('employee_id', selectedEmployeeId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as PunchRow[];
    },
  });

  // 7. Truy vấn danh sách ngày lễ trong khoảng thời gian lookback đầu tuần đến cuối tháng (+1 ngày) cho Báo cáo Bảng chấm công
  const holidaysKey = [
    'reports-holidays',
    user?.id,
    selectedPeriod?.year,
    selectedPeriod?.month,
  ];
  const {
    data: monthHolidays = [],
    isLoading: holidaysLoading,
    error: holidaysError,
    refetch: refetchHolidays,
  } = useQuery({
    queryKey: holidaysKey,
    enabled: !!user && isAdmin && !!selectedPeriod && reportMode === 'timesheet',
    queryFn: async () => {
      if (!selectedPeriod) return [];
      const { holidayStartDate, holidayEndDate } = getVietnamMonthBounds(
        selectedPeriod.year,
        selectedPeriod.month
      );
      const { data, error } = await supabase
        .from('holidays')
        .select('date,name')
        .gte('date', holidayStartDate)
        .lte('date', holidayEndDate)
        .order('date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as HolidayRow[];
    },
  });

  // Xóa thông báo kết xuất cũ khi người dùng đổi bộ lọc
  useEffect(() => {
    setExportFeedback(null);
  }, [reportMode, selectedPeriodId, selectedBranchId, selectedEmployeeId]);

  // Tổng hợp danh sách chi nhánh chấm công của từng nhân viên trong kỳ lương
  const employeeBranchesInPayrollPeriod = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const p of payrollPeriodPunches) {
      if (p.voided_at !== null) continue;
      const set = map.get(p.employee_id);
      if (set) {
        set.add(p.branch_id);
      } else {
        map.set(p.employee_id, new Set([p.branch_id]));
      }
    }
    return map;
  }, [payrollPeriodPunches]);

  // Tổng hợp danh sách khoản phụ cấp tháng của từng nhân viên
  const allowancesByEmployee = useMemo(() => {
    const map = new Map<string, PayrollMonthlyAllowanceItem[]>();
    for (const item of monthlyAllowances) {
      const entry: PayrollMonthlyAllowanceItem = {
        amount: Number(item.amount) || 0,
        reason: item.reason?.trim() ? item.reason.trim() : 'Phụ cấp tháng',
      };
      const existing = map.get(item.employee_id);
      if (existing) {
        existing.push(entry);
      } else {
        map.set(item.employee_id, [entry]);
      }
    }
    return map;
  }, [monthlyAllowances]);

  // Chuẩn bị dữ liệu dòng cho Báo cáo Bảng lương (khớp 100% giữa bảng xem trước và Excel export)
  const preparedPayrollRows = useMemo<PayrollWorkbookRowInput[]>(() => {
    const selectedBranchObj =
      selectedBranchId !== 'ALL' ? branchMap.get(selectedBranchId) : null;

    return payrollRows
      .filter((row) => {
        if (selectedEmployeeId !== 'ALL' && row.employee_id !== selectedEmployeeId) {
          return false;
        }
        if (selectedBranchId !== 'ALL') {
          const empBranches = employeeBranchesInPayrollPeriod.get(row.employee_id);
          if (!empBranches || !empBranches.has(selectedBranchId)) {
            return false;
          }
        }
        return true;
      })
      .map((row) => {
        const emp = employeeMap.get(row.employee_id);
        const empCode = emp?.employee_code ?? row.employee_id;
        const fullName = emp?.full_name ?? 'Nhân viên không xác định';

        let branchDisplay = 'Toàn công ty';
        if (selectedBranchObj) {
          branchDisplay = `${selectedBranchObj.code} - ${selectedBranchObj.name}`;
        } else {
          const empBranchIds = employeeBranchesInPayrollPeriod.get(row.employee_id);
          if (empBranchIds && empBranchIds.size > 0) {
            const labels = Array.from(empBranchIds)
              .map((bId) => {
                const b = branchMap.get(bId);
                return b ? `${b.code} - ${b.name}` : bId;
              })
              .sort((a, b) => a.localeCompare(b));
            branchDisplay = labels.join(', ');
          } else {
            branchDisplay = 'Không phát sinh chấm công';
          }
        }

        const empAllowances = allowancesByEmployee.get(row.employee_id) ?? [];
        const derivedHourlySubtotal = deriveHourlyPaySubtotalFromSnapshot(row);

        return {
          employee_code: empCode,
          full_name: fullName,
          branch_name: branchDisplay,
          hourly_rate_snapshot: Number(row.hourly_rate_snapshot) || 0,
          minutes_regular_day: Number(row.minutes_regular_day) || 0,
          minutes_regular_night: Number(row.minutes_regular_night) || 0,
          minutes_ot_day: Number(row.minutes_ot_day) || 0,
          minutes_ot_night: Number(row.minutes_ot_night) || 0,
          minutes_holiday_day: Number(row.minutes_holiday_day) || 0,
          minutes_holiday_night: Number(row.minutes_holiday_night) || 0,
          hourly_pay_subtotal: derivedHourlySubtotal,
          fixed_allowance_snapshot: Number(row.fixed_allowance_snapshot) || 0,
          monthly_allowances: empAllowances,
          total_salary: Number(row.total_salary) || 0,
        };
      })
      .sort((a, b) => a.employee_code.localeCompare(b.employee_code));
  }, [
    payrollRows,
    selectedEmployeeId,
    selectedBranchId,
    branchMap,
    employeeBranchesInPayrollPeriod,
    employeeMap,
    allowancesByEmployee,
  ]);

  // Tổng cộng cho bảng xem trước Bảng lương
  const payrollTotals = useMemo(() => {
    return preparedPayrollRows.reduce(
      (acc, r) => {
        const varAllowance = r.monthly_allowances.reduce(
          (sum, item) => sum + (Number(item.amount) || 0),
          0
        );
        acc.minutes_regular_day += r.minutes_regular_day;
        acc.minutes_regular_night += r.minutes_regular_night;
        acc.minutes_ot_day += r.minutes_ot_day;
        acc.minutes_ot_night += r.minutes_ot_night;
        acc.minutes_holiday_day += r.minutes_holiday_day;
        acc.minutes_holiday_night += r.minutes_holiday_night;
        acc.hourly_pay_subtotal += r.hourly_pay_subtotal;
        acc.fixed_allowance_snapshot += r.fixed_allowance_snapshot;
        acc.variable_allowance_total += varAllowance;
        acc.total_salary += r.total_salary;
        return acc;
      },
      {
        minutes_regular_day: 0,
        minutes_regular_night: 0,
        minutes_ot_day: 0,
        minutes_ot_night: 0,
        minutes_holiday_day: 0,
        minutes_holiday_night: 0,
        hourly_pay_subtotal: 0,
        fixed_allowance_snapshot: 0,
        variable_allowance_total: 0,
        total_salary: 0,
      }
    );
  }, [preparedPayrollRows]);

  // Chuẩn bị dữ liệu dòng cho Báo cáo Bảng chấm công thực tế (Timesheet)
  const holidayDateSet = useMemo(() => {
    const set = new Set<string>();
    for (const h of monthHolidays) {
      if (h.date) set.add(h.date);
    }
    return set;
  }, [monthHolidays]);

  const preparedTimesheetRows = useMemo<TimesheetWorkbookRowInput[]>(() => {
    if (!selectedPeriod) return [];
    const { monthToken, firstWeekMondayVn, startIso, endIso } = getVietnamMonthBounds(
      selectedPeriod.year,
      selectedPeriod.month
    );
    return buildTimesheetRowsFromPunches({
      punches: timesheetPunches,
      holidayDateSet,
      targetMonthToken: monthToken,
      firstWeekMondayVn,
      monthStartMs: new Date(startIso).getTime(),
      monthEndMs: new Date(endIso).getTime(),
      selectedBranchId,
      employeeMap,
      branchMap,
    });
  }, [
    selectedPeriod,
    timesheetPunches,
    holidayDateSet,
    selectedBranchId,
    employeeMap,
    branchMap,
  ]);

  // Tổng cộng tháng chỉ cộng từ các dòng hợp lệ thực tế (những phiên lỗi/cảnh báo đã có 0 giờ công)
  const timesheetTotals = useMemo(() => {
    return preparedTimesheetRows.reduce(
      (acc, r) => {
        acc.work_hours += r.work_hours;
        acc.overtime_hours += r.overtime_hours;
        acc.session_count += r.session_count;
        if (r.status && r.status.startsWith('Cảnh báo:')) {
          acc.warning_rows += 1;
        }
        return acc;
      },
      { work_hours: 0, overtime_hours: 0, session_count: 0, warning_rows: 0 }
    );
  }, [preparedTimesheetRows]);

  const selectedBranchObj = useMemo(
    () => (selectedBranchId !== 'ALL' ? branchMap.get(selectedBranchId) ?? null : null),
    [selectedBranchId, branchMap]
  );

  // Xử lý sự kiện nhấn nút Xuất Excel (.xlsx)
  const handleExportWorkbook = async () => {
    if (!selectedPeriod || isExporting) return;

    setIsExporting(true);
    setExportFeedback(null);

    try {
      if (reportMode === 'payroll') {
        const branchLabel = selectedBranchObj
          ? `${selectedBranchObj.code} - ${selectedBranchObj.name}`
          : 'Tất cả chi nhánh (Toàn công ty)';

        const filename = await exportPayrollWorkbook({
          year: selectedPeriod.year,
          month: selectedPeriod.month,
          branchLabel,
          exportedAt: new Date(),
          rows: preparedPayrollRows,
        });

        setExportFeedback({
          type: 'success',
          message: `Đã kết xuất và tải xuống tệp "${filename}" thành công (${preparedPayrollRows.length} nhân sự).`,
        });
      } else {
        const branchCode = selectedBranchObj ? selectedBranchObj.code : 'TAT_CA';

        const filename = await exportTimesheetWorkbook({
          year: selectedPeriod.year,
          month: selectedPeriod.month,
          branchCode,
          exportedAt: new Date(),
          rows: preparedTimesheetRows,
        });

        setExportFeedback({
          type: 'success',
          message: `Đã kết xuất và tải xuống tệp "${filename}" thành công (${preparedTimesheetRows.length} dòng ngày công).`,
        });
      }
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error
          ? err.message
          : 'Đã xảy ra lỗi không xác định khi kết xuất tệp Excel.';
      setExportFeedback({
        type: 'error',
        message: errorMessage,
      });
    } finally {
      setIsExporting(false);
    }
  };

  if (authLoading) {
    return (
      <div className="p-6 text-sm text-gray-600">
        Đang kiểm tra phiên đăng nhập và quyền truy cập...
      </div>
    );
  }

  // Bảo vệ nghiêm ngặt: ProtectedRoute của /admin cho phép cả manager và admin,
  // nên màn hình /admin/reports bắt buộc chặn rõ ràng nếu role không phải là admin.
  if (!isAdmin) {
    return (
      <div
        role="alert"
        className="bg-red-50 border border-red-200 rounded-lg p-6 text-red-800 space-y-2 max-w-2xl"
      >
        <h2 className="text-base font-bold">Từ chối truy cập (Chỉ dành cho Admin)</h2>
        <p className="text-sm">
          Phân hệ Trung tâm Báo cáo & Xuất Excel chứa dữ liệu lương và bảng công toàn hệ thống,
          chỉ tài khoản Quản trị viên (Admin) mới được phép truy cập.
        </p>
      </div>
    );
  }

  if (periodsLoading || branchesLoading || employeesLoading) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center text-sm text-gray-600 shadow-sm">
        Đang tải danh sách kỳ lương đã duyệt, chi nhánh và hồ sơ nhân sự...
      </div>
    );
  }

  const masterError = periodsError || branchesError || employeesError;
  if (masterError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-sm text-red-700 space-y-3">
        <div className="font-bold">
          Lỗi tải dữ liệu danh mục hệ thống: {(masterError as Error).message}
        </div>
        <button
          type="button"
          onClick={() => {
            void refetchPeriods();
            void refetchBranches();
            void refetchEmployees();
          }}
          className="px-4 py-2 bg-red-600 text-white rounded-md text-xs font-semibold hover:bg-red-700"
        >
          Thử tải lại
        </button>
      </div>
    );
  }

  if (approvedPeriods.length === 0) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-8 text-center space-y-3 shadow-sm">
        <h2 className="text-base font-bold text-gray-800">
          Chưa có kỳ lương nào được duyệt chính thức
        </h2>
        <p className="text-sm text-gray-600 max-w-xl mx-auto">
          Tính năng kết xuất Báo cáo Excel chỉ áp dụng cho các kỳ lương đã chốt sổ (
          <code className="px-1.5 py-0.5 bg-gray-100 rounded text-xs">status = approved</code>).
          Vui lòng kiểm tra và duyệt bảng công tại mục{' '}
          <Link
            to="/admin/payroll/preview"
            className="text-blue-600 font-semibold hover:underline"
          >
            Xem trước & Duyệt lương
          </Link>{' '}
          trước khi xuất báo cáo.
        </p>
      </div>
    );
  }

  const activeDataLoading =
    reportMode === 'payroll'
      ? payrollLoading || allowancesLoading || payrollPunchesLoading
      : timesheetPunchesLoading || holidaysLoading;

  const activeDataError =
    reportMode === 'payroll'
      ? payrollError || allowancesError || payrollPunchesError
      : timesheetPunchesError || holidaysError;

  const activeRowsCount =
    reportMode === 'payroll' ? preparedPayrollRows.length : preparedTimesheetRows.length;

  const handleRetryActiveData = () => {
    if (reportMode === 'payroll') {
      void refetchPayrollRows();
      void refetchAllowances();
      void refetchPayrollPunches();
    } else {
      void refetchTimesheetPunches();
      void refetchHolidays();
    }
  };

  return (
    <div className="space-y-6">
      {/* Header giới thiệu & Nút xuất Excel */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 shadow-sm flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900">
            Trung tâm Báo cáo & Xuất Excel (.xlsx)
          </h2>
          <p className="text-xs text-gray-600 mt-1">
            Xem trước dữ liệu đã duyệt và kết xuất tệp Excel chuẩn định dạng kế toán trực tiếp trên
            trình duyệt (lazy-load ExcelJS, không tiêu tốn CPU Worker).
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={isExporting || activeDataLoading || !!activeDataError || activeRowsCount === 0}
            onClick={() => void handleExportWorkbook()}
            className="inline-flex items-center justify-center px-5 py-2.5 rounded-md text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-300 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors shadow-sm"
          >
            {isExporting
              ? 'Đang tạo tệp Excel (.xlsx)...'
              : reportMode === 'payroll'
                ? `Xuất Excel Bảng lương (${preparedPayrollRows.length})`
                : `Xuất Excel Bảng chấm công (${preparedTimesheetRows.length})`}
          </button>
        </div>
      </div>

      {/* Bộ lọc đa chiều: Loại báo cáo, Kỳ lương đã duyệt, Chi nhánh, Nhân viên */}
      <div className="bg-white border border-gray-200 rounded-lg p-5 shadow-sm space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <div>
            <label
              htmlFor="report-mode-select"
              className="block text-xs font-semibold text-gray-700 mb-1"
            >
              Loại báo cáo kết xuất
            </label>
            <select
              id="report-mode-select"
              value={reportMode}
              onChange={(e) => setReportMode(e.target.value as ReportMode)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white font-medium text-gray-900"
            >
              <option value="payroll">1. Báo cáo Bảng lương tháng (Snapshot đã duyệt)</option>
              <option value="timesheet">2. Báo cáo Bảng chấm công chi tiết (Theo ngày)</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="report-period-select"
              className="block text-xs font-semibold text-gray-700 mb-1"
            >
              Kỳ lương đã duyệt (Tháng/Năm)
            </label>
            <select
              id="report-period-select"
              value={selectedPeriodId}
              onChange={(e) => setSelectedPeriodId(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white font-medium text-gray-900"
            >
              {approvedPeriods.map((p) => (
                <option key={p.id} value={p.id}>
                  Tháng {String(p.month).padStart(2, '0')}/{p.year} (Đã chốt sổ)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="report-branch-select"
              className="block text-xs font-semibold text-gray-700 mb-1"
            >
              Phạm vi Chi nhánh
            </label>
            <select
              id="report-branch-select"
              value={selectedBranchId}
              onChange={(e) => setSelectedBranchId(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white font-medium text-gray-900"
            >
              <option value="ALL">Tất cả chi nhánh (TAT_CA)</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.code} — {b.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="report-employee-select"
              className="block text-xs font-semibold text-gray-700 mb-1"
            >
              Nhân viên cụ thể
            </label>
            <select
              id="report-employee-select"
              value={selectedEmployeeId}
              onChange={(e) => setSelectedEmployeeId(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white font-medium text-gray-900"
            >
              <option value="ALL">Tất cả nhân viên</option>
              {employees.map((emp) => (
                <option key={emp.id} value={emp.id}>
                  {emp.employee_code} — {emp.full_name}
                  {!emp.is_active ? ' (Ngừng HĐ)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Ghi chú nghiệp vụ minh bạch theo từng chế độ báo cáo */}
        {reportMode === 'payroll' ? (
          <div className="space-y-2 pt-2 border-t border-gray-100 text-xs">
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-amber-900">
              <strong>Lưu ý khi lọc Bảng lương theo Chi nhánh:</strong> Dữ liệu bảng{' '}
              <code>payroll</code> được chốt cố định (snapshot) ở cấp độ từng nhân viên trên toàn
              công ty, không tách nhỏ tiền lương theo từng chi nhánh. Khi chọn một chi nhánh cụ thể
              {selectedBranchObj ? ` (${selectedBranchObj.code} — ${selectedBranchObj.name})` : ''},
              báo cáo lọc ra các nhân viên có ít nhất 1 lượt chấm công hợp lệ tại chi nhánh đó trong
              kỳ và hiển thị <strong>toàn bộ tổng lương tháng</strong> của nhân viên đó.
            </div>
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-md text-blue-900">
              <strong>Giải thích cột &ldquo;Lương theo giờ (Tạm tính hiển thị)&rdquo;:</strong> Bảng{' '}
              <code>payroll</code> chỉ lưu trữ <code>hourly_rate_snapshot</code>, 6 cột số phút đã
              duyệt, <code>fixed_allowance_snapshot</code>, <code>total_allowance</code> và{' '}
              <code>total_salary</code>. Cột <em>Lương theo giờ</em> trên màn hình và trong file
              Excel được dẫn xuất hiển thị từ đơn giá snapshot nhân với 6 nhóm số phút theo hệ số
              (1.0x / 1.3x / 1.5x / 1.8x / 2.0x / 2.3x); cột{' '}
              <strong>Tổng lương thực nhận (total_salary)</strong> luôn giữ nguyên giá trị snapshot
              chính thức đã lưu trong cơ sở dữ liệu.
            </div>
          </div>
        ) : (
          <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-md text-xs text-indigo-950">
            <strong>Lưu ý về Báo cáo Bảng chấm công chi tiết:</strong> Báo cáo này tổng hợp{' '}
            <strong>thời gian thực tế (raw elapsed minutes trừ thời gian nghỉ hợp lệ)</strong> theo
            ngày vào ca (<code>clock_in</code> giờ Việt Nam) mà <strong>không phải</strong> số phút
            đã qua làm tròn lưới 15 phút của bảng lương. Cột <em>Giờ công chuẩn (Thực tế)</em> hiển
            thị tổng toàn bộ số giờ làm việc ròng thực tế trong ngày, và cột{' '}
            <em>Giờ tăng ca (&gt;48h/tuần)</em> hiển thị phần giờ vượt ngưỡng 48 giờ làm việc ngày
            thường/tuần (tính cả các ca đầu tuần thuộc tháng trước trong cùng tuần Thứ Hai–Chủ Nhật
            giờ VN để xác định đúng ngưỡng 48 giờ nhưng không xuất trùng ca tháng trước; ngày lễ
            trong bảng <code>holidays</code> không tiêu tốn ngưỡng 48 giờ). Các ca thiếu lượt đóng
            hoặc sai trình tự thời gian được giữ mức 0 giờ và gắn nhãn cảnh báo rõ ràng.
          </div>
        )}

        {/* Thông báo phản hồi kết xuất Excel */}
        {exportFeedback && (
          <div
            role="status"
            className={`p-3 rounded-md border text-xs font-medium flex items-center justify-between ${
              exportFeedback.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-red-50 border-red-200 text-red-800'
            }`}
          >
            <span>{exportFeedback.message}</span>
            <button
              type="button"
              onClick={() => setExportFeedback(null)}
              className="ml-4 underline font-semibold"
            >
              Đóng
            </button>
          </div>
        )}
      </div>

      {/* Khu vực hiển thị bảng xem trước (Preview Table) */}
      {activeDataError ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-sm text-red-700 space-y-3">
          <div className="font-bold">
            Không thể tải dữ liệu báo cáo: {(activeDataError as Error).message}
          </div>
          <button
            type="button"
            onClick={handleRetryActiveData}
            className="px-4 py-2 bg-red-600 text-white rounded-md text-xs font-semibold hover:bg-red-700"
          >
            Thử lại
          </button>
        </div>
      ) : activeDataLoading ? (
        <div className="bg-white border border-gray-200 rounded-lg p-10 text-center text-sm text-gray-600 shadow-sm">
          Đang truy vấn và tổng hợp dữ liệu báo cáo theo bộ lọc đã chọn...
        </div>
      ) : reportMode === 'payroll' ? (
        preparedPayrollRows.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-10 text-center text-sm text-gray-500 shadow-sm">
            Không có bản ghi bảng lương nào khớp với điều kiện lọc hiện tại.
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
            <div className="p-4 border-b border-gray-200 bg-gray-50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-gray-900">
                  Xem trước Báo cáo Bảng lương — Tháng{' '}
                  {selectedPeriod ? String(selectedPeriod.month).padStart(2, '0') : ''}/
                  {selectedPeriod?.year}
                </h3>
                <p className="text-xs text-gray-500">
                  Tên tệp khi xuất:{' '}
                  <code className="font-mono text-gray-700">
                    Bang_Luong_Thang_{selectedPeriod?.year}-
                    {String(selectedPeriod?.month ?? '').padStart(2, '0')}.xlsx
                  </code>
                </p>
              </div>
              <div className="text-xs text-gray-600">
                Tổng số dòng xuất: <strong>{preparedPayrollRows.length}</strong> nhân viên
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="bg-gray-100 border-b border-gray-200 text-gray-700">
                    <th className="p-2.5 border-r border-gray-200 text-center">STT</th>
                    <th className="p-2.5 border-r border-gray-200">Mã NV</th>
                    <th className="p-2.5 border-r border-gray-200">Họ và tên</th>
                    <th className="p-2.5 border-r border-gray-200">Chi nhánh</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">Đơn giá giờ</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">Phút thường ngày</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">Phút thường đêm</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">Phút TC ngày</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">Phút TC đêm</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">Phút lễ ngày</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">Phút lễ đêm</th>
                    <th
                      className="p-2.5 border-r border-gray-200 text-right"
                      title="Dẫn xuất hiển thị từ đơn giá snapshot và 6 nhóm số phút đã duyệt; không ghi đè Tổng lương thực nhận"
                    >
                      Lương theo giờ (Dẫn xuất)*
                    </th>
                    <th className="p-2.5 border-r border-gray-200 text-right">PC cố định</th>
                    <th className="p-2.5 border-r border-gray-200 text-right">PC phát sinh</th>
                    <th className="p-2.5 border-r border-gray-200">Chi tiết PC phát sinh</th>
                    <th className="p-2.5 text-right bg-blue-50 text-blue-900">
                      Tổng lương thực nhận
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {preparedPayrollRows.map((row, idx) => {
                    const varAllowanceSum = row.monthly_allowances.reduce(
                      (s, item) => s + (Number(item.amount) || 0),
                      0
                    );
                    const varAllowanceText =
                      row.monthly_allowances.length === 0
                        ? 'Không có'
                        : row.monthly_allowances
                            .map((item) => `${item.reason}: ${formatVND(item.amount)}`)
                            .join('; ');

                    return (
                      <tr key={row.employee_code} className="hover:bg-gray-50 align-top">
                        <td className="p-2.5 border-r border-gray-200 text-center text-gray-500">
                          {idx + 1}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 font-mono font-bold text-gray-900 whitespace-nowrap">
                          {row.employee_code}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 font-medium text-gray-900 whitespace-nowrap">
                          {row.full_name}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-gray-700">
                          {row.branch_name}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          {formatVND(row.hourly_rate_snapshot)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          {formatMinutes(row.minutes_regular_day)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          {formatMinutes(row.minutes_regular_night)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          {formatMinutes(row.minutes_ot_day)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          {formatMinutes(row.minutes_ot_night)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          {formatMinutes(row.minutes_holiday_day)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          {formatMinutes(row.minutes_holiday_night)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right font-medium text-gray-800 whitespace-nowrap">
                          {formatVND(row.hourly_pay_subtotal)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          {formatVND(row.fixed_allowance_snapshot)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                          {formatVND(varAllowanceSum)}
                        </td>
                        <td className="p-2.5 border-r border-gray-200 text-gray-600 max-w-xs">
                          {varAllowanceText}
                        </td>
                        <td className="p-2.5 text-right font-bold text-blue-900 bg-blue-50/40 whitespace-nowrap">
                          {formatVND(row.total_salary)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-100 border-t-2 border-gray-300 font-bold text-gray-900">
                    <td colSpan={5} className="p-2.5 border-r border-gray-200 text-center">
                      TỔNG CỘNG ({preparedPayrollRows.length} nhân sự)
                    </td>
                    <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                      {formatMinutes(payrollTotals.minutes_regular_day)}
                    </td>
                    <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                      {formatMinutes(payrollTotals.minutes_regular_night)}
                    </td>
                    <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                      {formatMinutes(payrollTotals.minutes_ot_day)}
                    </td>
                    <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                      {formatMinutes(payrollTotals.minutes_ot_night)}
                    </td>
                    <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                      {formatMinutes(payrollTotals.minutes_holiday_day)}
                    </td>
                    <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                      {formatMinutes(payrollTotals.minutes_holiday_night)}
                    </td>
                    <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                      {formatVND(payrollTotals.hourly_pay_subtotal)}
                    </td>
                    <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                      {formatVND(payrollTotals.fixed_allowance_snapshot)}
                    </td>
                    <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                      {formatVND(payrollTotals.variable_allowance_total)}
                    </td>
                    <td className="p-2.5 border-r border-gray-200"></td>
                    <td className="p-2.5 text-right text-blue-900 bg-blue-100/60 whitespace-nowrap">
                      {formatVND(payrollTotals.total_salary)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )
      ) : preparedTimesheetRows.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-10 text-center text-sm text-gray-500 shadow-sm">
          Không có dữ liệu chấm công trong kỳ khớp với điều kiện lọc hiện tại.
        </div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden">
          <div className="p-4 border-b border-gray-200 bg-gray-50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-gray-900">
                Xem trước Báo cáo Bảng chấm công chi tiết — Tháng{' '}
                {selectedPeriod ? String(selectedPeriod.month).padStart(2, '0') : ''}/
                {selectedPeriod?.year}
              </h3>
              <p className="text-xs text-gray-500">
                Tên tệp khi xuất:{' '}
                <code className="font-mono text-gray-700">
                  Bang_Cong_Chi_Nhanh_{selectedBranchObj ? selectedBranchObj.code : 'TAT_CA'}_
                  {selectedPeriod?.year}-
                  {String(selectedPeriod?.month ?? '').padStart(2, '0')}.xlsx
                </code>
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs text-gray-600">
              <span>
                Tổng số dòng ngày công: <strong>{preparedTimesheetRows.length}</strong>
              </span>
              {timesheetTotals.warning_rows > 0 && (
                <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 font-semibold">
                  {timesheetTotals.warning_rows} dòng có cảnh báo chuỗi chấm công
                </span>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="bg-gray-100 border-b border-gray-200 text-gray-700">
                  <th className="p-2.5 border-r border-gray-200 text-center">STT</th>
                  <th className="p-2.5 border-r border-gray-200">Mã NV</th>
                  <th className="p-2.5 border-r border-gray-200">Họ và tên</th>
                  <th className="p-2.5 border-r border-gray-200">Chi nhánh</th>
                  <th className="p-2.5 border-r border-gray-200 text-center">Ngày (VN)</th>
                  <th className="p-2.5 border-r border-gray-200 text-right">
                    Giờ công chuẩn (Thực tế)
                  </th>
                  <th className="p-2.5 border-r border-gray-200 text-right">
                    Giờ tăng ca (&gt;48h/tuần)
                  </th>
                  <th className="p-2.5 border-r border-gray-200 text-right">Số ca chấm công</th>
                  <th className="p-2.5">Trạng thái / Cảnh báo</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {preparedTimesheetRows.map((row, idx) => {
                  const hasWarning = Boolean(row.status && row.status.startsWith('Cảnh báo:'));
                  return (
                    <tr
                      key={`${row.employee_code}_${row.date}`}
                      className={`hover:bg-gray-50 align-top ${
                        hasWarning ? 'bg-amber-50/60' : ''
                      }`}
                    >
                      <td className="p-2.5 border-r border-gray-200 text-center text-gray-500">
                        {idx + 1}
                      </td>
                      <td className="p-2.5 border-r border-gray-200 font-mono font-bold text-gray-900 whitespace-nowrap">
                        {row.employee_code}
                      </td>
                      <td className="p-2.5 border-r border-gray-200 font-medium text-gray-900 whitespace-nowrap">
                        {row.full_name}
                      </td>
                      <td className="p-2.5 border-r border-gray-200 text-gray-700">
                        {row.branch_name}
                      </td>
                      <td className="p-2.5 border-r border-gray-200 text-center font-mono text-gray-800 whitespace-nowrap">
                        {row.date}
                      </td>
                      <td className="p-2.5 border-r border-gray-200 text-right font-medium text-gray-900 whitespace-nowrap">
                        {formatHours(row.work_hours)} giờ
                      </td>
                      <td className="p-2.5 border-r border-gray-200 text-right font-medium text-gray-900 whitespace-nowrap">
                        {formatHours(row.overtime_hours)} giờ
                      </td>
                      <td className="p-2.5 border-r border-gray-200 text-right text-gray-800 whitespace-nowrap">
                        {row.session_count}
                      </td>
                      <td
                        className={`p-2.5 ${
                          hasWarning ? 'text-amber-900 font-semibold' : 'text-gray-700'
                        }`}
                      >
                        {row.status ?? 'Bình thường'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-gray-100 border-t-2 border-gray-300 font-bold text-gray-900">
                  <td colSpan={5} className="p-2.5 border-r border-gray-200 text-center">
                    TỔNG CỘNG ({preparedTimesheetRows.length} dòng ngày công)
                  </td>
                  <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                    {formatHours(timesheetTotals.work_hours)} giờ
                  </td>
                  <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                    {formatHours(timesheetTotals.overtime_hours)} giờ
                  </td>
                  <td className="p-2.5 border-r border-gray-200 text-right whitespace-nowrap">
                    {vndFormatter.format(timesheetTotals.session_count)}
                  </td>
                  <td className="p-2.5"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}