import { useState, useEffect } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { EMPLOYEE_CODE_REGEX } from '@timekeeping/shared/auth';
import { ProtectedRoute } from '../components/route-guard';
import { KioskLayout } from '../layouts/KioskLayout';
import { lookupEmployee, safePunch, type KioskAction, type KioskLookupResult } from '../lib/kiosk';
import { useScreenWakeLock } from '../lib/use-screen-wake-lock';

// Ranh giới xác thực dành riêng cho thiết bị chấm công, sẵn sàng tách gói lazy
export const Route = createFileRoute('/kiosk/')({ component: KioskRouteComponent });

function KioskRouteComponent() {
  const [now, setNow] = useState(() => new Date());
  const [online, setOnline] = useState(() => navigator.onLine);
  const [code, setCode] = useState('');
  const [emp, setEmp] = useState<KioskLookupResult | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<KioskAction | null>(null);
  const [pin, setPin] = useState('');

  // Duy trì màn hình luôn sáng trong suốt thời gian mở trang Kiosk
  const wakeLock = useScreenWakeLock(true);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      clearInterval(t);
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Khôi phục kết nối mạng: tự động đồng bộ lại trạng thái nhân viên từ máy chủ mà không xóa dữ liệu hiện tại nếu lỗi
  useEffect(() => {
    const currentCode = emp?.employee_code;
    if (!online || !currentCode) return;
    let cancelled = false;
    lookupEmployee(currentCode)
      .then((fresh) => {
        if (!cancelled) setEmp(fresh);
      })
      .catch(() => {
        // Giữ nguyên dữ liệu nhân viên đang hiển thị nếu truy vấn lại thất bại
      });
    return () => {
      cancelled = true;
    };
  }, [online, emp?.employee_code]);

  const reset = () => {
    setCode('');
    setEmp(null);
    setMsg(null);
    setPendingAction(null);
    setPin('');
  };

  // Trạng thái chuẩn luôn đọc trực tiếp từ máy chủ
  const handleLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedCode = code.trim();
    if (!trimmedCode || !online) return;
    // Kiểm tra mã nhân viên (chuỗi số 4–6 chữ số, không bắt đầu bằng 0) và xóa nhân viên cũ tránh chấm nhầm
    if (!EMPLOYEE_CODE_REGEX.test(trimmedCode)) {
      setEmp(null);
      setMsg({ text: 'Mã nhân viên không hợp lệ (gồm 4–6 chữ số và không bắt đầu bằng số 0).' });
      return;
    }
    setLoading(true);
    setMsg(null);
    try {
      const res = await lookupEmployee(trimmedCode);
      setEmp(res);
    } catch (err: any) {
      setEmp(null);
      setMsg({ text: err?.message || 'Không tìm thấy nhân viên.' });
    } finally {
      setLoading(false);
    }
  };

  // Bất biến ngoại tuyến: chặn chấm công khi mất mạng, không lưu hàng đợi cục bộ
  const handleAction = (action: KioskAction) => {
    if (!emp || !online) return;
    setPendingAction(action);
    setPin('');
  };

  const submitPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emp || !online || !pendingAction || pin.length < 4 || pin.length > 6) return;
    const action = pendingAction;
    setLoading(true);
    setMsg(null);
    try {
      await safePunch(emp.employee_code, pin, action);
      setMsg({ text: 'Chấm công thành công!', ok: true });
      setTimeout(reset, 3000);
    } catch (err: any) {
      setMsg({ text: err?.message || 'Lỗi chấm công, vui lòng thử lại.' });
    } finally {
      setPendingAction(null);
      setPin('');
      setLoading(false);
    }
  };

  const st = emp?.current_state;
  const stateLabel = st === 'working' ? 'Đang làm việc' : st === 'on_break' ? 'Đang nghỉ giải lao' : 'Ngoài ca / Chưa vào ca';

  return (
    <ProtectedRoute allowedRoles={['kiosk']}>
      <KioskLayout>
        <div className={`w-full py-2 text-center text-sm font-medium ${online ? 'bg-emerald-900/60 text-emerald-200' : 'bg-rose-900 text-white'}`}>
          {online ? 'Trực tuyến — Đồng bộ máy chủ' : 'Mất kết nối mạng — Tạm ngưng chấm công'}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center max-w-md mx-auto w-full gap-6">
          <div>
            <div className="text-5xl font-mono font-bold">{now.toLocaleTimeString('vi-VN')}</div>
            <p className="mt-1 text-slate-400">{now.toLocaleDateString('vi-VN')}</p>
            <p className="mt-1 text-xs text-slate-500">
              {wakeLock.active
                ? 'Chế độ giữ sáng màn hình: Đang bật'
                : wakeLock.supported
                  ? 'Chế độ giữ sáng màn hình: Tạm ngưng (chạm màn hình hoặc cài đặt Tự động khóa: Không)'
                  : 'Trình duyệt không hỗ trợ giữ sáng tự động — vui lòng đặt Tự động khóa: Không trên thiết bị'}
            </p>
          </div>
          <form onSubmit={handleLookup} className="flex w-full gap-2">
            {/* Giữ mã nhân viên dạng chuỗi văn bản nhưng bật bàn phím số trên iPad */}
            <input type="text" inputMode="numeric" pattern="[1-9][0-9]{3,5}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Nhập mã nhân viên..." disabled={!online || loading} className="flex-1 rounded border border-slate-700 bg-slate-900 px-4 py-3 text-white" />
            <button type="submit" disabled={!online || loading} className="rounded bg-blue-600 px-5 py-3 font-semibold disabled:opacity-50">Tra cứu</button>
          </form>
          {msg && <div className={`w-full rounded p-3 text-sm ${msg.ok ? 'bg-emerald-900/80 text-emerald-200' : 'bg-rose-900/80 text-rose-200'}`}>{msg.text}</div>}
          {emp && (
            <div className="w-full rounded-lg border border-slate-800 bg-slate-900/60 p-4 space-y-4">
              <div><div className="text-lg font-bold">{emp.full_name || emp.employee_code}</div><div className="text-sm text-amber-400">Trạng thái: {stateLabel}</div></div>
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => handleAction('clock_in')} disabled={!online || loading || st === 'working' || st === 'on_break'} className="rounded bg-emerald-600 py-3 font-semibold disabled:opacity-30">Vào ca</button>
                <button onClick={() => handleAction('break_start')} disabled={!online || loading || st !== 'working'} className="rounded bg-amber-600 py-3 font-semibold disabled:opacity-30">Bắt đầu nghỉ</button>
                <button onClick={() => handleAction('break_end')} disabled={!online || loading || st !== 'on_break'} className="rounded bg-sky-600 py-3 font-semibold disabled:opacity-30">Kết thúc nghỉ</button>
                <button onClick={() => handleAction('clock_out')} disabled={!online || loading || (st !== 'working' && st !== 'on_break')} className="rounded bg-rose-600 py-3 font-semibold disabled:opacity-30">Tan ca</button>
              </div>
              <button onClick={reset} className="text-xs text-slate-400 underline">Hủy / Đổi nhân viên</button>
            </div>
          )}
          {pendingAction && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
              <form onSubmit={submitPin} className="w-full max-w-xs space-y-4 rounded-lg border border-slate-700 bg-slate-900 p-5">
                <div className="text-base font-bold text-white">Nhập mã PIN xác nhận</div>
                <div className="h-7 text-xl tracking-widest text-amber-400">{'•'.repeat(pin.length)}</div>
                <input type="password" inputMode="numeric" maxLength={6} autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="4-6 chữ số..." disabled={loading} className="w-full rounded border border-slate-700 bg-slate-950 px-4 py-3 text-center text-lg tracking-widest text-white" />
                <div className="flex gap-2">
                  <button type="button" onClick={() => { setPendingAction(null); setPin(''); }} disabled={loading} className="flex-1 rounded bg-slate-700 py-2.5 font-semibold text-white">Hủy</button>
                  <button type="submit" disabled={loading || !online || pin.length < 4 || pin.length > 6} className="flex-1 rounded bg-emerald-600 py-2.5 font-semibold text-white disabled:opacity-40">Xác nhận</button>
                </div>
              </form>
            </div>
          )}
        </div>
      </KioskLayout>
    </ProtectedRoute>
  );
}