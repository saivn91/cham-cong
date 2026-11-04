// Hằng số vai trò hệ thống cho phân quyền (RBAC)
export const ROLES = {
  EMPLOYEE: 'employee',
  MANAGER: 'manager',
  ADMIN: 'admin',
  KIOSK: 'kiosk',
} as const;

// Danh sách vai trò hợp lệ dùng cho kiểm duyệt schema
export const ROLE_VALUES = [ROLES.EMPLOYEE, ROLES.MANAGER, ROLES.ADMIN, ROLES.KIOSK] as const;

export type AppRole = (typeof ROLE_VALUES)[number];

export const ROLE_LABELS: Record<AppRole, string> = {
  employee: 'Nhân viên',
  manager: 'Quản lý',
  admin: 'Quản trị viên',
  kiosk: 'Thiết bị Kiosk',
};

// Biểu thức chính quy kiểm tra mã nhân viên số: 4–6 chữ số, không bắt đầu bằng chữ số 0 (1000..999999)
export const EMPLOYEE_CODE_REGEX = /^[1-9][0-9]{3,5}$/;

// Tên miền email nội bộ cố định (synthetic email) ánh xạ 1-1 từ mã nhân viên sang Supabase Auth
export const EMPLOYEE_EMAIL_DOMAIN = 'staff.chamcong.invalid';

// Chuẩn hóa, kiểm tra định dạng mã nhân viên số và sinh địa chỉ synthetic email dùng chung cho FE/Worker
export function employeeCodeToEmail(employeeCode: string): string {
  const normalized = employeeCode.trim();
  if (!EMPLOYEE_CODE_REGEX.test(normalized)) {
    throw new Error('INVALID_EMPLOYEE_CODE');
  }
  return `${normalized}@${EMPLOYEE_EMAIL_DOMAIN}`;
}

// Kiểm tra giá trị có phải là AppRole hợp lệ
export function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (ROLE_VALUES as readonly string[]).includes(value);
}

// Kiểm tra quyền hạn cấp quản lý hoặc quản trị viên
export function isManagerOrAdmin(role: AppRole | null | undefined): boolean {
  return role === ROLES.MANAGER || role === ROLES.ADMIN;
}
