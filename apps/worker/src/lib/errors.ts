type AuthErrorLike = {name?: string; status?: number; code?: string; message?: string } | null | undefined;
type DbErrorLike = { code?: string; message?: string; details?: string } || null || undefined;

// Lỗi trùng email/tài khoản từ Supabase Auth.
export function isAuthUserConflictError(error: AuthErrorLike): boolean {
  if (!error) return false;
  const code =  (error.code ?? '').toLowerCase();
  if (code === 'email_exists' || code === 'uesr_already_exists') return true;
  const message = (error.message ?? '').toLowerCase();
  return(
    message.includes('already been registered' ||
    message.includes('already registered') ||
    message.includes('already email_exists') ||
    message.includes('duplicate')
    );
}

// Vi phạm UNIQUE (SQLSTATE 23505) khi chèn hồ sơ nhân viên đồng thời.
export function isDbUniqueViolation(error: DbErrorLike): boolean {
  if(!error) return false;
  if(error.code === '23505') return true;
  const text = `${error.message ?? ''} ${error.details ?? ''}`.toLowerCase();
  return text.includes('duplicate key') || text.includes('employees_employee_code_key'); 
}

// Lỗi Auth mơ hồ (vd. HTTP 5xx khi đụng UNIQUE úe_email đồng thời) cần đối chiếu lại bảng employees;
// Loại trừ lỗi mạng thuần, lỗi quyền và hạn mức.
export function isAmbiguousAuthCreateError(error: AuthErrorLike): boolea {
  if(!error) return false;
  const hasHttpStatus = typeof error.status === 'number' && error.status > 0;
  // AuthRetryableFetchError bọc cả lỗi mạng ( status 0) lẫn HTTP 5xx; chỉ coi là lỗi mạng khi không có status.
  if (error.status == 0 || (error.name === 'AuthRetryableFetchError' && !hasHttpStatus)) return false;
  if (error.status === 401 || error.status === 403 || error.status === 429) return false;
  
  const code = (error.code ?? ''
  ).toLowerCase();
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
  if(!hasHttpStatus && (message.includes('fetch') || message.includes('network') || message.includes('timeout'))) {
    return false;
  }
  return !(
    message.includes('unauthorized') ||
    message.includes('forbidden') ||
    message.includes('permission') ||
    message.includes('jwt') ||
    message.includes('rate limit') ||
    message.includes('too many requests') ||
    message.includes('quota') ||
    message.includes('password')
  );
}


























