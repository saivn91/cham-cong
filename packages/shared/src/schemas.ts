import { z } from 'zod';
import { ROLE_VALUES } from './auth';

export const appRoleSchema = z.enum(ROLE_VALUES);

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  service: z.literal('timekeeping-worker'),
  timestamp: z.string().datetime(),
});

export const createUserPayloadSchema = z.object({
  email: z.string().email('Email không hợp lệ'),
  fullName: z.string().min(2, 'Họ tên tối thiểu 2 ký tự').max(100),
  role: appRoleSchema,
  employeeCode: z.string().min(1).max(32).optional(),
});

export const kioskClockPayloadSchema = z.object({
  pinOrToken: z.string().min(4).max(128),
  action: z.enum(['clock_in', 'clock_out']),
  deviceId: z.string().uuid(),
  capturedAt: z.string().datetime().optional(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type CreateUserPayload = z.infer<typeof createUserPayloadSchema>;
export type KioskClockPayload = z.infer<typeof kioskClockPayloadSchema>;
