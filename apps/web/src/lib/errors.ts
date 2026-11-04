// Ánh xạ lỗi từ Supabase sang thông báo tiếng Việt thân thiện
export function mapSupabaseError(error: unknown): string {
  const err = error as { code?: string; message?: string } | null;
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  const combined = `${code} ${msg}`;

  if (combined.includes('ORPHANED_PUNCHES')) return 'Ca làm việc trước chưa kết thúc.';
  if (combined.includes('PIN_LOCKED')) return 'Mã PIN đã bị khóa do nhập sai nhiều lần.';
  if (combined.includes('INVALID_ACTION')) return 'Thao tác không hợp lệ.';
  if (combined.includes('DEVICE_REVOKED')) return 'Thiết bị đã bị thu hồi quyền truy cập.';

  switch (code) {
    case '23P01':
      return 'Thời gian bị trùng lặp.';
    case '23514':
      return 'Dữ liệu không hợp lệ.';
    case '23505':
      return 'Dữ liệu đã tồn tại.';
    case 'P0001':
      return msg || 'Lỗi xử lý nghiệp vụ.';
    case '42501':
      return 'Bạn không có quyền thực hiện thao tác này.';
    default:
      return 'Đã có lỗi xảy ra. Vui lòng thử lại.';
  }
}
