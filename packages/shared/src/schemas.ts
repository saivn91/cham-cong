import { z } from 'zod';
import { EMPLOYEE_CODE_REGEX, ROLE_VALUES } from './auth';

// Xác thực vai trò thuộc danh sách hệ thống (RBAC)
export const appRoleSchema = z.enum(ROLE_VALUES);

// Schema for the worker service health check response
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.literal('timekeeping-worker'),
  timestamp: z.string().datetime(),
});

// Xác thực tạo người dùng: mã nhân viên số 4–6 chữ số (không có số 0 ở đầu), mật khẩu >= 8 ký tự,
// PIN kiosk 4-6 chữ số, chi nhánh chính tùy chọn (nullable UUID). Không nhận email từ client (Worker tự sinh từ mã nhân viên).
// Chỉ cho phép tạo nhân sự với vai trò 'employee' hoặc 'manager' (tài khoản 'admin' chỉ được khởi tạo thủ công trên Supabase).
export const createUserPayloadSchema = z
  .object({
    password: z.string().min(8, 'Mật khẩu tối thiểu 8 ký tự'),
    fullName: z.string().min(2, 'Họ tên tối thiểu 2 ký tự').max(100),
    role: z.enum(['employee', 'manager']),
    employeeCode: z
      .string()
      .trim()
      .regex(EMPLOYEE_CODE_REGEX, 'Mã nhân viên phải gồm 4–6 chữ số và không bắt đầu bằng 0'),
    hourlyRate: z.number().finite().min(0),
    fixedAllowance: z.number().finite().min(0).default(0),
    pin: z.string().regex(/^\d{4,6}$/, 'PIN phải có 4–6 chữ số'),
    homeBranchId: z.string().uuid().nullable().optional(),
  })
  .strict();

// Xác thực đặt lại mật khẩu (tối thiểu 8 ký tự)
export const resetPasswordPayloadSchema = z.object({
  password: z.string().min(8, 'Mật khẩu tối thiểu 8 ký tự'),
});

// Xác thực đăng ký kiosk
export const createDevicePayloadSchema = z.object({
  branchId: z.string().uuid(),
  name: z.string().min(1).max(100),
});

// Xác thực ghép nối kiosk: bắt buộc mã gồm đúng 6 chữ số
export const pairDevicePayloadSchema = z.object({
  code: z.string().regex(/^\d{6}$/, 'Mã ghép nối phải có 6 chữ số'),
});

// Xác thực chấm công tại kiosk: giới hạn độ dài PIN/token (4-128 ký tự) để chống lạm dụng
export const kioskClockPayloadSchema = z.object({
  pinOrToken: z.string().min(4).max(128),
  action: z.enum(['clock_in', 'clock_out']),
  deviceId: z.string().uuid(),
  capturedAt: z.string().datetime().optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type CreateUserPayload = z.infer<typeof createUserPayloadSchema>;
export type ResetPasswordPayload = z.infer<typeof resetPasswordPayloadSchema>;
export type CreateDevicePayload = z.infer<typeof createDevicePayloadSchema>;
export type PairDevicePayload = z.infer<typeof pairDevicePayloadSchema>;
export type KioskClockPayload = z.infer<typeof kioskClockPayloadSchema>;
