import { supabase } from './supabase';
import { apiFetch } from './api';

export type KioskAction = 'clock_in' | 'break_start' | 'break_end' | 'clock_out';
export type KioskState = 'working' | 'on_break' | 'off';

export interface KioskLookupResult {
  ok?: boolean;
  employee_code: string;
  full_name?: string;
  current_state: KioskState | string;
  [key: string]: unknown;
}

export interface KioskPunchResult {
  ok?: boolean;
  success?: boolean;
  current_state?: KioskState | string;
  punched_at?: string;
  [key: string]: unknown;
}

const ERROR_MESSAGES: Record<string, string> = {
  not_found: 'Không tìm thấy nhân viên.',
  employee_not_found: 'Không tìm thấy nhân viên.',
  invalid_pin: 'Mã PIN không chính xác.',
  pin_locked: 'Mã PIN đang bị khóa tạm thời do nhập sai nhiều lần.',
  rate_limited: 'Thao tác quá nhanh, vui lòng thử lại sau ít phút.',
  invalid_state: 'Trạng thái hiện tại không hợp lệ cho thao tác này.',
  invalid_transition: 'Thao tác chấm công không phù hợp với trạng thái hiện tại.',
  invalid_action: 'Thao tác chấm công không hợp lệ.',
  unauthorized_device: 'Thiết bị chưa được cấp quyền chấm công.',
  inactive_employee: 'Tài khoản nhân viên đã ngừng hoạt động.',
};

function toVietnameseError(payload: Record<string, unknown> | null | undefined, fallback: string): Error {
  const code =
    typeof payload?.error === 'string'
      ? payload.error
      : typeof payload?.code === 'string'
        ? payload.code
        : '';
  const message = typeof payload?.message === 'string' ? payload.message : '';
  return new Error(ERROR_MESSAGES[code] || message || ERROR_MESSAGES[message] || fallback);
}

function isNetworkError(err: unknown): boolean {
  const msg =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === 'string'
        ? (err as { message: string }).message
        : String(err ?? '');
  return err instanceof TypeError || /fetch|network|timeout|offline|load failed|networkerror/i.test(msg);
}

export async function lookupEmployee(employeeCode: string): Promise<KioskLookupResult> {
  const code = employeeCode.trim();
  const { data, error } = await supabase.rpc('kiosk_lookup', {
    p_employee_code: code,
  } as never);

  if (error) {
    if (isNetworkError(error)) {
      throw new TypeError('Lỗi kết nối mạng khi tra cứu nhân viên.');
    }
    throw new Error(error.message || 'Không thể tra cứu thông tin nhân viên.');
  }

  const res = data as Record<string, unknown> | null;
  if (!res || res.ok !== true) {
    throw toVietnameseError(res, 'Không tìm thấy nhân viên hoặc mã không hợp lệ.');
  }

  return {
    ...(res as unknown as KioskLookupResult),
    employee_code: code,
  };
}

// Thời gian chuẩn từ server; tuyệt đối không lưu cache chấm công ngoại tuyến.
export async function punch(employeeCode: string, pin: string, action: KioskAction): Promise<KioskPunchResult> {
  const { data, error } = await supabase.rpc('kiosk_punch', {
    p_employee_code: employeeCode.trim(),
    p_pin: pin,
    p_action: action,
  } as never);

  if (error) {
    if (isNetworkError(error)) {
      throw new TypeError(error.message || 'Network error');
    }
    throw new Error(error.message || 'Chấm công thất bại, vui lòng thử lại.');
  }

  const res = data as Record<string, unknown> | null;
  if (!res || res.ok !== true) {
    throw toVietnameseError(res, 'Chấm công thất bại, vui lòng kiểm tra lại thông tin.');
  }

  return {
    ...(res as unknown as KioskPunchResult),
    success: true,
  };
}

export async function safePunch(employeeCode: string, pin: string, action: KioskAction): Promise<KioskPunchResult> {
  try {
    return await punch(employeeCode, pin, action);
  } catch (err) {
    if (isNetworkError(err)) {
      throw new Error('Lỗi kết nối mạng. Vui lòng kiểm tra lại trạng thái hiện tại trước khi thử lại.');
    }
    throw err instanceof Error ? err : new Error('Chấm công thất bại, vui lòng thử lại.');
  }
}

export async function pairDevice<T = unknown>(code: string): Promise<T> {
  return apiFetch<T>('/api/devices/pair', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}
