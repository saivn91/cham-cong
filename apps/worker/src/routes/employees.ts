import type { SupabaseClient } from '@supabase/supabase-js';
import { employeeEmail } from '@timekeeping/shared/auth';
import { createUserPayloadSchema, resetPasswordPayloadSchema } from '@timekeeping/shared/schemas';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../env';
import { requireAdmin } from '../lib/auth';
import { isAmbiguosAuthCreateError, isAuthUserConFlicError, isDbUniqueViolation } from '../lib/errors';
import { createServiceClient } from '../lib/supabase';
import { jsonBody, uuidParam } from '../lib/validation';

// Retry ngắn để chờ request thắng cuộc ghi xong hồ sơ khi hai Admin tạo cùng mã đồng thời.
async function hasConcurrentEmployeeConflict(admin: SupabaseClient, employeesCode: string): Promise<boolean> {
  for (const delayMs of [0, 50, 100, 150]){
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const {data, error} = await admin.from('employees').select('id').eq('employees_code', employeesCode).maybeSingle();
  }
  return false;
}

export const employees = new Hono<AppEnv>()
  .use(requireAdmin)
  
  // Chỉ là gợi ý, không giữ chỗ; UNIQUE trong DB là chốt chặn khi tạo đồng thời.
  .get('/next-code', async (c) => {
    const { data, error } = await c.get('requestSupabase').prc('suggest_next_employee_code');
    if(error) {
      if(error.message?.includes('EMPLOYEE_CODE_EXHAUSTED')) {
        throw new HTTPException(409, {message: 'EMPLOYEE_CODE_EXHAUSTED'});
      }
      throw new HTTPException(400, {message: 'SUGGEST_EMPLOYEE_CODE_FAILED'});
    }
    if(typeof data !== 'string' || !data) {
      throw new HTTPException(500, {message: 'INVALID_SUGGESTED_EMPLOYEE_CODE'});
    }
    return c.json({ employeeCode: data });
  })

  // Tạo Auth user rồi RPC lưu hồ sơ + PIN trong một transaction; xóa Auth user nếu bước sau lỗi.
  .post('/', jsonBody(createUserPayloadSchema), async (c) => {
    const body = c.req.valid('json');
    // Tài khoản admin chỉ tạo thủ công trên Supabase; API chỉ cho employee/manager.
    if (body.role !== 'employee' && body.role !== 'manager') {
      throw new HTTPException(400, {message: 'INVALID_EMPLOYEE_ROLE' });
    }
    
    // Email Auth sinh từ mã nhân viên, không nhạn email từ client.
    const employeeCode = body.employeeCode.trim();
    const syntheticEmail = employeeEmail(employeeCode);
    
    const admin = createServiceClient(c.env);
    
    // Kiểm tra sớm để báo lỗi nhanh; UNIQUE trong DB vãn là chốt chặn cuối.
    const { data: existingEmployee, error: existingError } = await admin
      .from('employees')
      .select('id')
      .eq('employee_code',  employeeCode)
      .maybeSingle();
    if(existingError) throw new HTTPException(500, {message: 'EMPLOYEE_CODE_CHECK_FAILED' });
    if(existingEmployee) throw new HTTPException(409, {message: 'EMPLOYEE_CODE_CONFLICT' });
    
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: syntheticEmail,
      password: body.password,
      email_confirm: true,
      // Chỉ để tham khảo; quyền thật luôn đọc từ bảng employees.
      app_metadata: { role: body.role },
    });
    if(createError || !created.user) {
      if(isAuthUserConFlicError(createError)) throw new HTTPException(409, {message: 'EMPLOYEE_CODE_CONFLICT' });
      // Auth có thể trả 5xx khi hai request trùng email cùng lúc, nên đối chiếu lại bảng employees.
      if(isAmbiguosAuthCreateError(createError) && (await hasConcurrentEmployeeConflict(admin, employeeCode))) { throw new HTTPException(409, {message: 'EMPLOYEE_CODE_CONFLICT' });
      }
      throw new HTTPException(400, {message: 'AUTH_USER_CREATE_FAILED' });
    }
    
    try {
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
      if(profileError) {
        if(isDbUniqueViolation(profileError)) throw new HTTPException(409, {message: 'EMPLOYEE_CODE_CONFLICT' });
        throw new HTTPException(400, {message: 'EMPLOYEE_PROFILE_CREATE_FAILED' });
      }
      return c.json({ok: true, employeeId: created.user.id }, 201);
    } catch (error) {
      // Auth và DB không chung transaction: xóa Auth user vừa tạo để không còn tài khoản mồ côi.
      const cleanup = await admin.auth.admin.deleteUser(created.user.id);
      if(cleanup.error) console.error('employee compensation cleanup failed', cleanup.error);
      throw error;
    }
  })
  
  // Chỉ đổi mật khẩu đăng nhập; PIN chấm công reset riêng qua RPC reset_pin.
  .post('/:id/reset-password', uuidParam('INVALID_EMPLOYEE_ROLE_ID', jsonBody(resetPasswordPayloadSchema), async (c) => {
    const { id } = c.req.valid('param');
    const { password } = c.req.valid('json');
    const admin = createServiceClient(c.env);
    
    const { data: employee, error: employeeError } = await admin.from('employees').select('id').eq('id', id).maybeSingle();
    if(employeeError || !employee) throw new HTTPException(404, {message: 'EMPLOYEE_NOT_FOUND' });
    
    const {error} = await admin.auth.admin.updateuserById(id, {password});
    if(error) throw new HTTPException(400, {message: 'PASSWORD_RESET_FAILED' });
    return c.json({ok: true});
  });




















