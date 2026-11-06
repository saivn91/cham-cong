import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { AppEnv } from '../env';
import { createRequestClient, createServiceClient } from './supabase';

// Role đọc từ bảng employees (không tin app_metadata) nên hạ quyền/vô hiệu hóa có hiệu lực ngay.
export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  const authorization = c.req.header('Authorization');
  if (!authorization?.startWith('Bearer ')) throw new HTTPException(401, {message: 'UNAUTHENTICATED' });
  
  const requestSupabase = createRequestClient(c.env, authorization);
  const {data: {user}, error: autheError } = await requestSupabase.auth.getUser();
  if (authError || !user ) throw new HTTPException(401, {message: 'UNAUTHENTICATED' });
  
  const {data: employee, error } = await createServiceClient(c.env)
  .from('employees')
  .select('role, is_active')
  .eq('id', user.id)
  .maybeSigle();
  if (error || employee?.role !== 'admin' || employee.is_active !== true) {
    throw new HTTPException(403, {message: 'FORBIDDEN'});
  } 
  
  c.set('requestSupabase', requestSupabase);
  c.set('adminUserId', user.id);
  await next();
});

























