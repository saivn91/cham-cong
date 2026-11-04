import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { employeeCodeToEmail } from '@timekeeping/shared/auth';
import {
  createDevicePayloadSchema,
  createUserPayloadSchema,
  pairDevicePayloadSchema,
  resetPasswordPayloadSchema,
} from '@timekeeping/shared/schemas';

// Khai báo biến môi trường (secrets/config) và biến ngữ cảnh theo từng request.
export type Env = {
  Bindings: {
    SUPABASE_URL: string;
    SUPABASE_ANON_KEY: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    ALLOWED_ORIGIN?: string;
  };
  Variables: { adminUserId: string; requestSupabase: SupabaseClient };
};

const app = new Hono<Env>();

// Ranh giới service-role: tạo Supabase client quyền cao (bỏ qua RLS) cho các thao tác quản trị và Auth.
function serviceClient(env: Env['Bindings']) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Ranh giới RLS: tạo Supabase client chuyển tiếp Bearer token của người gọi để thực thi RLS trên truy vấn và RPC.
function requestClient(c: { env: Env['Bindings']; req: { header(name: string): string | undefined } }) {
  const authorization = c.req.header('Authorization');
  return createClient(c.env.SUPABASE_URL, c.env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: authorization ? { Authorization: authorization } : {} },
  });
}

// Đọc và validate JSON body theo Zod schema; trả về lỗi 400 nếu sai định dạng hoặc không hợp lệ.
async function jsonBody<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>) {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'INVALID_JSON' });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HTTPException(400, { message: 'INVALID_REQUEST', cause: parsed.error.flatten() });
  return parsed.data;
}

// Băm SHA-256 dạng hex để bảo mật mã ghép nối (pairing code) trước khi lưu hoặc đối chiếu trong DB.
async function sha256(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Sinh mã ghép nối 6 chữ số ngẫu nhiên phân phối đều bằng CSPRNG (loại bỏ các byte >= 250).
function randomPairingCode() {
  const digits: string[] = [];
  const bytes = new Uint8Array(16);
  while (digits.length < 6) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 250 && digits.length < 6) digits.push(String(byte % 10));
    }
  }
  return digits.join('');
}

// Kiểm tra lỗi trùng email/tài khoản từ Supabase Auth để quy đổi về mã lỗi nghiệp vụ thống nhất mà không lộ chi tiết nhạy cảm.
function isAuthUserConflictError(error: { status?: number; code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  const code = (error.code ?? '').toLowerCase();
  if (code === 'email_exists' || code === 'user_already_exists') return true;
  const message = (error.message ?? '').toLowerCase();
  return (
    message.includes('already been registered') ||
    message.includes('already registered') ||
    message.includes('already exists') ||
    message.includes('duplicate')
  );
}

// Kiểm tra lỗi vi phạm ràng buộc UNIQUE (SQLSTATE 23505) khi chèn hồ sơ nhân viên đồng thời.
function isDbUniqueViolation(error: { code?: string; message?: string; details?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '23505') return true;
  const text = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase();
  return text.includes('duplicate key') || text.includes('employees_employee_code_key');
}

// Phân loại lỗi Auth mơ hồ (như HTTP 500/5xx khi đụng độ UNIQUE users_email đồng thời) cần đối chiếu lại bảng employees; loại trừ lỗi mạng thuần không có HTTP status, lỗi quyền và hạn mức.
function isAmbiguousAuthCreateError(
  error: { name?: string; status?: number; code?: string; message?: string } | null | undefined,
): boolean {
  if (!error) return false;
  const hasHttpStatus = typeof error.status === 'number' && error.status > 0;
  // Supabase Auth SDK bọc cả lỗi mạng (status 0) lẫn phản hồi HTTP 500/5xx từ server vào AuthRetryableFetchError; chỉ coi là lỗi mạng khi không có HTTP status từ server.
  if (error.status === 0 || (error.name === 'AuthRetryableFetchError' && !hasHttpStatus)) {
    return false;
  }
  if (error.status === 401 || error.status === 403 || error.status === 429) return false;
  const code = (error.code ?? '').toLowerCase();
  if (
    code === 'not_admin' ||
    code === 'bad_jwt' ||
    code === 'no_authorization' ||
    code === 'weak_password' ||
    code === 'validation_failed' ||
    code.includes('rate_limit') ||
    code.includes('quota')
  ) {
    return false;
  }
  const message = (error.message ?? '').toLowerCase();
  if (!hasHttpStatus && (message.includes('fetch') || message.includes('network') || message.includes('timeout'))) {
    return false;
  }
  if (
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('permission') ||
    message.includes('jwt') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('quota') ||
    message.includes('password')
  ) {
    return false;
  }
  return true;
}

// Kiểm tra lại mã nhân viên với bounded retry ngắn (50/100/150ms) để chờ request thắng cuộc hoàn tất ghi hồ sơ khi có race tại tầng Auth.
async function hasConcurrentEmployeeConflict(admin: SupabaseClient, employeeCode: string): Promise<boolean> {
  for (const delayMs of [0, 50, 100, 150]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const { data, error } = await admin.from('employees').select('id').eq('employee_code', employeeCode).maybeSingle();
    if (!error && data) return true;
  }
  return false;
}

// Tách danh sách ALLOWED_ORIGIN (mặc định là Vite dev server cục bộ).
const allowedOrigins = (value?: string) => (value ?? 'http://localhost:5173').split(',').map((v) => v.trim()).filter(Boolean);

// Áp dụng whitelist CORS cho các route API, cho phép gửi credentials và header Authorization.
app.use('/api/*', cors({
  origin: (origin, c) => (allowedOrigins(c.env.ALLOWED_ORIGIN).includes(origin) ? origin : ''),
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  exposeHeaders: ['Content-Length'],
  maxAge: 86400,
  credentials: true,
}));

// Ranh giới xác thực & phân quyền: kiểm tra JWT, tách luồng pairing riêng cho kiosk, và yêu cầu quyền admin đang hoạt động cho các route còn lại.
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();
  if (!c.req.header('Authorization')?.startsWith('Bearer ')) throw new HTTPException(401, { message: 'UNAUTHENTICATED' });
  const requestSupabase = requestClient(c);
  const { data: { user }, error: authError } = await requestSupabase.auth.getUser();
  if (authError || !user) throw new HTTPException(401, { message: 'UNAUTHENTICATED' });
  c.set('requestSupabase', requestSupabase);
  // Chỉ tài khoản role 'kiosk' mới được gọi route pairing và tuyệt đối không được tồn tại trong bảng employees.
  if (c.req.path === '/api/devices/pair') {
    if (user.app_metadata?.role !== 'kiosk') throw new HTTPException(403, { message: 'FORBIDDEN' });
    const { data: employee, error } = await serviceClient(c.env).from('employees').select('id').eq('id', user.id).maybeSingle();
    if (error || employee) throw new HTTPException(403, { message: 'FORBIDDEN' });
    return next();
  }
  const { data: employee, error } = await serviceClient(c.env).from('employees').select('role, is_active').eq('id', user.id).maybeSingle();
  if (error || employee?.role !== 'admin' || employee.is_active !== true) throw new HTTPException(403, { message: 'FORBIDDEN' });
  c.set('adminUserId', user.id);
  return next();
});

// Xử lý lỗi tập trung: chuẩn hóa phản hồi HTTPException và ẩn lỗi hệ thống không mong muốn dưới mã 500.
app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message, details: error.cause }, error.status);
  console.error(error);
  return c.json({ error: 'INTERNAL_SERVER_ERROR' }, 500);
});

// Endpoint kiểm tra trạng thái hoạt động công khai (bỏ qua bước xác thực).
app.get('/api/health', (c) => c.json({ ok: true, service: 'timekeeping-worker', timestamp: new Date().toISOString() }));

// Gợi ý mã nhân viên số tiếp theo (chỉ admin): gọi RPC theo ngữ cảnh JWT của admin; đây chỉ là gợi ý, không giữ chỗ.
app.get('/api/employees/next-code', async (c) => {
  const { data, error } = await c.get('requestSupabase').rpc('suggest_next_employee_code');
  if (error) {
    if (error.message?.includes('EMPLOYEE_CODE_EXHAUSTED')) {
      throw new HTTPException(409, { message: 'EMPLOYEE_CODE_EXHAUSTED' });
    }
    throw new HTTPException(400, { message: 'SUGGEST_EMPLOYEE_CODE_FAILED' });
  }
  if (typeof data !== 'string' || !data) {
    throw new HTTPException(500, { message: 'INVALID_SUGGESTED_EMPLOYEE_CODE' });
  }
  return c.json({ employeeCode: data });
});

// Tạo nhân viên (chỉ admin): tạo tài khoản Auth rồi gọi RPC lưu hồ sơ + mã PIN; tự động xóa tài khoản Auth (rollback bù trừ) nếu tạo hồ sơ thất bại.
app.post('/api/employees', async (c) => {
  const body = await jsonBody(c, createUserPayloadSchema);
  // Chặn sớm mọi vai trò ngoài 'employee' và 'manager' trước khi tạo tài khoản trên Supabase Auth.
  if (body.role !== 'employee' && body.role !== 'manager') throw new HTTPException(400, { message: 'INVALID_EMPLOYEE_ROLE' });

  // Chuẩn hóa mã nhân viên và tự sinh synthetic email từ helper dùng chung, tuyệt đối không nhận email từ client.
  const employeeCode = body.employeeCode.trim();
  let syntheticEmail: string;
  try {
    syntheticEmail = employeeCodeToEmail(employeeCode);
  } catch {
    throw new HTTPException(400, { message: 'INVALID_EMPLOYEE_CODE' });
  }

  const admin = serviceClient(c.env);

  // Kiểm tra sớm mã nhân viên đã tồn tại để phản hồi nhanh; ràng buộc UNIQUE trong DB vẫn là chốt chặn cuối khi có truy cập đồng thời.
  const { data: existingEmployee, error: existingError } = await admin
    .from('employees')
    .select('id')
    .eq('employee_code', employeeCode)
    .maybeSingle();
  if (existingError) throw new HTTPException(500, { message: 'EMPLOYEE_CODE_CHECK_FAILED' });
  if (existingEmployee) throw new HTTPException(409, { message: 'EMPLOYEE_CODE_CONFLICT' });

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: syntheticEmail,
    password: body.password,
    email_confirm: true,
    app_metadata: { role: body.role },
  });
  if (createError || !created.user) {
    if (isAuthUserConflictError(createError)) throw new HTTPException(409, { message: 'EMPLOYEE_CODE_CONFLICT' });
    if (isAmbiguousAuthCreateError(createError) && (await hasConcurrentEmployeeConflict(admin, employeeCode))) {
      throw new HTTPException(409, { message: 'EMPLOYEE_CODE_CONFLICT' });
    }
    throw new HTTPException(400, { message: 'AUTH_USER_CREATE_FAILED' });
  }
  try {
    // Lưu hồ sơ nhân viên kèm chi nhánh chính (mặc định null nếu không truyền) và mã PIN trong cùng transaction DB.
    const { error: profileError } = await admin.rpc('admin_create_employee_with_pin', {
      p_id: created.user.id,
      p_employee_code: employeeCode,
      p_full_name: body.fullName,
      p_role: body.role,
      p_hourly_rate: body.hourlyRate,
      p_fixed_allowance: body.fixedAllowance,
      p_pin: body.pin,
      p_home_branch_id: body.homeBranchId ?? null,
    });
    if (profileError) {
      if (isDbUniqueViolation(profileError)) throw new HTTPException(409, { message: 'EMPLOYEE_CODE_CONFLICT' });
      throw new HTTPException(400, { message: 'EMPLOYEE_PROFILE_CREATE_FAILED' });
    }
    return c.json({ ok: true, employeeId: created.user.id }, 201);
  } catch (error) {
    const cleanup = await admin.auth.admin.deleteUser(created.user.id);
    if (cleanup.error) console.error('employee compensation cleanup failed', cleanup.error);
    throw error;
  }
});

// Đặt lại mật khẩu nhân viên (chỉ admin): validate UUID và payload, kiểm tra nhân viên tồn tại rồi cập nhật mật khẩu trên Supabase Auth.
app.post('/api/employees/:id/reset-password', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) throw new HTTPException(400, { message: 'INVALID_EMPLOYEE_ID' });
  const body = await jsonBody(c, resetPasswordPayloadSchema);
  const admin = serviceClient(c.env);
  const { data: employee, error: employeeError } = await admin.from('employees').select('id').eq('id', id.data).maybeSingle();
  if (employeeError || !employee) throw new HTTPException(404, { message: 'EMPLOYEE_NOT_FOUND' });
  const { error } = await admin.auth.admin.updateUserById(id.data, { password: body.password });
  if (error) throw new HTTPException(400, { message: 'PASSWORD_RESET_FAILED' });
  return c.json({ ok: true });
});

// Cấp phát thiết bị (chỉ admin): tạo user Auth cho kiosk, sinh mã pairing một lần (chỉ lưu bản băm SHA-256 qua RPC), và rollback bù trừ (xóa thiết bị + user Auth) nếu lỗi.
app.post('/api/devices', async (c) => {
  const body = await jsonBody(c, createDevicePayloadSchema);
  const admin = serviceClient(c.env);
  const { data: kiosk, error: authError } = await admin.auth.admin.createUser({ email: body.email, password: body.password, email_confirm: true, app_metadata: { role: 'kiosk' } });
  if (authError || !kiosk.user) throw new HTTPException(400, { message: 'KIOSK_USER_CREATE_FAILED' });
  let createdDeviceId: string | undefined;
  try {
    const code = randomPairingCode();
    const { data: pairing, error: pairingError } = await c.get('requestSupabase').rpc('new_pairing_code', { p_code_hash: await sha256(code), p_branch_id: body.branchId, p_device_name: body.name });
    createdDeviceId = pairing?.device_id;
    if (pairingError || !createdDeviceId) throw new HTTPException(400, { message: 'DEVICE_CREATE_FAILED' });
    return c.json({ ok: true, deviceId: createdDeviceId, pairingCode: code, expiresAt: pairing.expires_at }, 201);
  } catch (error) {
    if (createdDeviceId) {
      const deviceCleanup = await admin.from('devices').delete().eq('id', createdDeviceId);
      if (deviceCleanup.error) console.error('device compensation cleanup failed', deviceCleanup.error);
    }
    const userCleanup = await admin.auth.admin.deleteUser(kiosk.user.id);
    if (userCleanup.error) console.error('kiosk user compensation cleanup failed', userCleanup.error);
    throw error;
  }
});

// Ghép nối thiết bị (chỉ kiosk): băm SHA-256 mã một lần và gọi RPC (theo ngữ cảnh RLS của kiosk) để tiêu thụ mã và gắn kết tài khoản kiosk với thiết bị.
app.post('/api/devices/pair', async (c) => {
  const body = await jsonBody(c, pairDevicePayloadSchema);
  const { data, error } = await c.get('requestSupabase').rpc('consume_pairing_code', { p_code_hash: await sha256(body.code) });
  if (error) throw new HTTPException(400, { message: error.message });
  return c.json(data);
});

// Thu hồi thiết bị (chỉ admin): đánh dấu thời điểm thu hồi (revoked_at) và khóa vĩnh viễn (ban 876000h) tài khoản Auth của kiosk liên kết.
app.post('/api/devices/:id/revoke', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) throw new HTTPException(400, { message: 'INVALID_DEVICE_ID' });
  const admin = serviceClient(c.env);
  const { data, error } = await admin.from('devices').update({ revoked_at: new Date().toISOString() }).eq('id', id.data).is('revoked_at', null).select('id, auth_user_id').maybeSingle();
  if (error || !data) throw new HTTPException(404, { message: 'DEVICE_NOT_FOUND_OR_ALREADY_REVOKED' });
  if (data.auth_user_id) await admin.auth.admin.updateUserById(data.auth_user_id, { ban_duration: '876000h' });
  return c.json({ ok: true, deviceId: data.id });
});

export default app;
