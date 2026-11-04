import { useMemo } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../lib/auth-context';
import { listMyPunches, type PunchWithBranch } from '../../lib/employee';

// Tuyến bảng chấm công nhân viên (layout và bảo vệ phân quyền do route cha /app quản lý)
export const Route = createFileRoute('/app/timesheet')({ component: EmployeeTimesheetComponent });

const VN_TZ = 'Asia/Ho_Chi_Minh';
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
// Mở rộng truy vấn 16 giờ trước và sau ranh giới tháng để ghép trọn vẹn các ca làm việc qua đêm (cross-midnight) ở đầu/cuối tháng
const BOUNDARY_BUFFER_MS = 16 * 60 * 60 * 1000;

// Tính giới hạn đầu tháng và cuối tháng theo múi giờ Việt Nam (Asia/Ho_Chi_Minh)
function getCurrentVnMonthBounds() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VN_TZ,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const year = Number(parts.find((p) => p.type === 'year')?.value ?? 2025);
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? 1);

  const startUtcMs = Date.UTC(year, month - 1, 1, 0, 0, 0, 0) - VN_OFFSET_MS;
  const endUtcMs = Date.UTC(year, month, 0, 23, 59, 59, 999) - VN_OFFSET_MS;

  return {
    year,
    month,
    startUtcMs,
    endUtcMs,
    fromIso: new Date(startUtcMs).toISOString(),
    toIso: new Date(endUtcMs).toISOString(),
    queryFromIso: new Date(startUtcMs - BOUNDARY_BUFFER_MS).toISOString(),
    queryToIso: new Date(endUtcMs + BOUNDARY_BUFFER_MS).toISOString(),
  };
}

function formatVnDate(isoStr: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: VN_TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(isoStr));
}

function formatVnTime(isoStr: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: VN_TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(isoStr));
}

function formatDurationMinutes(totalMinutes: number): string {
  const safeMins = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(safeMins / 60);
  const mins = safeMins % 60;
  return `${hours} giờ ${mins} phút`;
}

// Gom các lượt chấm công theo thứ tự thời gian thành từng phiên (ca làm việc) TRƯỚC KHI hiển thị.
// Mỗi lượt clock_in sẽ mở một phiên mới; các lượt tiếp theo (bao gồm nghỉ giữa ca và tan ca qua nửa đêm)
// được gắn vào phiên hiện tại cho đến khi gặp clock_in kế tiếp. Các lượt lẻ đầu chuỗi (chưa có clock_in) được giữ thành nhóm riêng.
type PunchSession = [PunchWithBranch, ...PunchWithBranch[]];

function groupPunchesIntoSessions(punches: PunchWithBranch[]): PunchSession[] {
  const chronological = [...punches].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const sessions: PunchSession[] = [];
  let currentSession: PunchWithBranch[] = [];

  for (const punch of chronological) {
    if (punch.type === 'clock_in') {
      if (currentSession.length > 0) {
        sessions.push(currentSession as PunchSession);
      }
      currentSession = [punch];
    } else {
      currentSession.push(punch);
    }
  }
  if (currentSession.length > 0) {
    sessions.push(currentSession as PunchSession);
  }
  return sessions;
}

// Tính thời lượng làm việc thực tế trong ngày (đã trừ thời gian nghỉ giữa ca) và cảnh báo nếu thiếu lượt chấm đóng/mở
// Lưu ý: Chỉ thống kê thời gian làm việc, tuyệt đối không tính lương tại đây.
function summarizeDayPunches(dayPunches: PunchWithBranch[]): { netMinutes: number; hasOrphan: boolean } {
  const sorted = [...dayPunches].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let workMs = 0;
  let hasOrphan = false;
  let clockInMs: number | null = null;
  let breakStartMs: number | null = null;
  let accumulatedBreakMs = 0;

  for (const p of sorted) {
    const t = Date.parse(p.at);
    if (p.type === 'clock_in') {
      if (clockInMs !== null) {
        hasOrphan = true;
      }
      clockInMs = t;
      breakStartMs = null;
      accumulatedBreakMs = 0;
    } else if (p.type === 'break_start') {
      if (clockInMs === null || breakStartMs !== null) {
        hasOrphan = true;
      } else {
        breakStartMs = t;
      }
    } else if (p.type === 'break_end') {
      if (clockInMs === null || breakStartMs === null) {
        hasOrphan = true;
      } else {
        accumulatedBreakMs += Math.max(0, t - breakStartMs);
        breakStartMs = null;
      }
    } else if (p.type === 'clock_out') {
      if (clockInMs === null || breakStartMs !== null) {
        hasOrphan = true;
      } else {
        workMs += Math.max(0, t - clockInMs - accumulatedBreakMs);
      }
      clockInMs = null;
      breakStartMs = null;
      accumulatedBreakMs = 0;
    }
  }

  if (clockInMs !== null || breakStartMs !== null) {
    hasOrphan = true;
  }

  return { netMinutes: workMs / 60000, hasOrphan };
}

function EmployeeTimesheetComponent() {
  const { user } = useAuth();
  const { year, month, startUtcMs, endUtcMs, queryFromIso, queryToIso } = useMemo(() => getCurrentVnMonthBounds(), []);

  // RLS chỉ trả về dữ liệu chấm công hợp lệ thuộc về nhân viên đang đăng nhập
  const { data: punches = [], isLoading, isError, error } = useQuery({
    queryKey: ['my-punches', user?.id, queryFromIso, queryToIso],
    queryFn: () => listMyPunches(queryFromIso, queryToIso),
    enabled: Boolean(user?.id),
  });

  // Ghép phiên theo trình tự thời gian trước để không cắt đứt ca đêm qua ngày mới,
  // sau đó chỉ giữ các phiên có mốc bắt đầu (lượt chấm đầu tiên) thuộc tháng đang chọn và sắp xếp mới nhất lên trên.
  const sessions = useMemo(() => {
    const allSessions = groupPunchesIntoSessions(punches);
    const monthSessions = allSessions.filter((session) => {
      const anchorMs = Date.parse(session[0].at);
      return anchorMs >= startUtcMs && anchorMs <= endUtcMs;
    });
    return monthSessions.sort((a, b) => Date.parse(b[0].at) - Date.parse(a[0].at));
  }, [punches, startUtcMs, endUtcMs]);

  const typeLabel: Record<string, string> = { clock_in: 'Vào ca', break_start: 'Bắt đầu nghỉ', break_end: 'Kết thúc nghỉ', clock_out: 'Tan ca' };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-800">Bảng chấm công</h1>
        <p className="text-sm text-gray-600">Lịch sử tháng {month}/{year} (Múi giờ Việt Nam)</p>
      </div>
      {isLoading && <div className="rounded-lg border bg-white p-4"><p className="text-sm text-gray-600">Đang tải dữ liệu...</p></div>}
      {isError && <div className="rounded-lg border border-red-200 bg-red-50 p-4"><p className="text-sm text-red-600">Không thể tải dữ liệu: {error instanceof Error ? error.message : 'Đã xảy ra lỗi.'}</p></div>}
      {!isLoading && !isError && sessions.length === 0 && <div className="rounded-lg border bg-white p-4"><p className="text-sm text-gray-600">Chưa có lượt chấm trong tháng này.</p></div>}
      {!isLoading && !isError && sessions.map((sessionPunches) => {
        const firstPunch = sessionPunches[0];
        const dateStr = formatVnDate(firstPunch.at);
        const summary = summarizeDayPunches(sessionPunches);
        return (
            <div key={firstPunch.id} className="overflow-hidden rounded-lg border bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-gray-50 px-4 py-2">
              <span className="font-medium text-gray-700">Ngày {dateStr}</span>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="font-medium text-gray-700">
                  Thời gian làm (đã trừ nghỉ): <strong className="text-gray-900">{formatDurationMinutes(summary.netMinutes)}</strong>
                </span>
                {summary.hasOrphan && (
                  <span className="rounded bg-amber-100 px-2 py-0.5 font-medium text-amber-800">
                    Chưa khép ca / thiếu lượt chấm
                  </span>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-4 py-2">Loại</th>
                    <th className="px-4 py-2">Thời gian</th>
                    <th className="px-4 py-2">Nguồn</th>
                    <th className="px-4 py-2">Chi nhánh</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {sessionPunches.map((punch) => (
                    <tr key={punch.id}>
                      <td className="px-4 py-2 font-medium">{typeLabel[punch.type] ?? punch.type}</td>
                      <td className="px-4 py-2">{formatVnTime(punch.at)}</td>
                      <td className="px-4 py-2">{punch.source === 'kiosk' ? 'Kiosk' : 'Thủ công'}</td>
                      <td className="px-4 py-2">{punch.branches?.name ?? punch.branches?.code ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
