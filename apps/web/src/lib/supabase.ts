import { createClient } from '@supabase/supabase-js'
import type { Database } from '@timekeeping/shared/database.types'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Thiếu cấu hình môi trường: Cần khai báo VITE_SUPABASE_URL và VITE_SUPABASE_ANON_KEY.')
}

// Bảo mật: Chỉ dùng anon key phía client, quyền truy cập dữ liệu được kiểm soát hoàn toàn bởi RLS.
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey)
