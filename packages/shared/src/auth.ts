export const ROLES = {
  EMPLOYEE: 'employee',
  MANAGER: 'manager',
  ADMIN: 'admin',
  KIOSK: 'kiosk',
} as const;

export const ROLE_VALUES = [ROLES.EMPLOYEE, ROLES.MANAGER, ROLES.ADMIN, ROLES.KIOSK] as const;

export type AppRole = (typeof ROLE_VALUES)[number];

export const ROLE_LABELS: Record<AppRole, string> = {
  employee: 'Nhân viên',
  manager: 'Quản lý',
  admin: 'Quản trị viên',
  kiosk: 'Thiết bị Kiosk',
};

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === 'string' && (ROLE_VALUES as readonly string[]).includes(value);
}

export function isManagerOrAdmin(role: AppRole | null | undefined): boolean {
  return role === ROLES.MANAGER || role === ROLES.ADMIN;
}
