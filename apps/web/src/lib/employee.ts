import { supabase } from './supabase'
import type { Tables, TablesInsert } from '@timekeeping/shared/database.types'

export type ShiftWithBranch = Tables<'shifts'> & {
  branches: Pick<Tables<'branches'>, 'code' | 'name'> | null
}

export type ShiftTemplate = Tables<'shift_templates'>

export type PunchWithBranch = Tables<'punches'> & {
  branches: Pick<Tables<'branches'>, 'code' | 'name'> | null
}

export type ChangePinResponse = {
  ok?: boolean
  error?: string
}

// Lấy ID của người dùng đang đăng nhập để lọc tường minh dữ liệu cá nhân bên cạnh RLS
async function requireCurrentUserId(): Promise<string> {
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) {
    throw new Error('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.')
  }
  return user.id
}

// RLS tự động giới hạn chỉ trả về các ca làm việc của chính nhân viên đang đăng nhập
// Lọc theo khoảng giao nhau (overlap): end_at > fromIso VÀ start_at < toIso để lấy cả ca đêm bắt đầu trước fromIso
export async function listMyShifts(fromIso: string, toIso: string) {
  const userId = await requireCurrentUserId()
  const { data, error } = await supabase
    .from('shifts')
    .select('*, branches(code, name)')
    .eq('employee_id', userId)
    .gt('end_at', fromIso)
    .lt('start_at', toIso)
    .order('start_at', { ascending: true })

  if (error) throw error
  return (data ?? []) as ShiftWithBranch[]
}

export async function listShiftTemplates() {
  const { data, error } = await supabase
    .from('shift_templates')
    .select('*')
    .order('name', { ascending: true })

  if (error) throw error
  return (data ?? []) as ShiftTemplate[]
}

export async function createMyShift(params: {
  employeeId: string
  branchId: string
  startAt: string
  endAt: string
  note?: string
}) {
  const startMs = new Date(params.startAt).getTime()
  const endMs = new Date(params.endAt).getTime()

  // Kiểm tra khoảng thời gian hợp lệ ở phía client (end > start và tối đa 12 giờ)
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    throw new Error('Thời gian ca làm không hợp lệ.')
  }
  if (endMs <= startMs) {
    throw new Error('Giờ kết thúc phải sau giờ bắt đầu.')
  }
  const maxDurationMs = 12 * 60 * 60 * 1000
  if (endMs - startMs > maxDurationMs) {
    throw new Error('Độ dài ca làm không được vượt quá 12 giờ.')
  }

  // Cột start_at và end_at là GENERATED ALWAYS từ cột during (tstzrange) nên chỉ gửi during khi insert.
  // Ép kiểu cục bộ sang TablesInsert<'shifts'> vì định nghĩa type hiện tại yêu cầu start_at/end_at.
  const payload = {
    employee_id: params.employeeId,
    branch_id: params.branchId,
    during: `[${new Date(startMs).toISOString()},${new Date(endMs).toISOString()})`,
    status: 'pending',
    note: params.note?.trim() || null,
  } as unknown as TablesInsert<'shifts'>

  const { data, error } = await supabase
    .from('shifts')
    .insert(payload)
    .select()
    .single()

  if (error) throw error
  return data
}

// RLS chỉ cho phép xóa ca làm việc tương lai của bản thân khi trạng thái còn là pending
export async function deletePendingShift(shiftId: string) {
  const userId = await requireCurrentUserId()
  const { data, error } = await supabase
    .from('shifts')
    .delete()
    .eq('id', shiftId)
    .eq('employee_id', userId)
    .eq('status', 'pending')
    .gt('start_at', new Date().toISOString())
    .select()
    .maybeSingle()

  if (error) throw error
  if (!data) {
    throw new Error('Không thể hủy ca làm việc (ca không tồn tại, đã được duyệt hoặc đã diễn ra).')
  }
}

// RLS giới hạn chỉ xem được lịch sử chấm công của chính nhân viên
export async function listMyPunches(fromIso: string, toIso: string) {
  const userId = await requireCurrentUserId()
  const { data, error } = await supabase
    .from('punches')
    .select('*, branches(code, name)')
    .eq('employee_id', userId)
    .is('voided_at', null)
    .gte('at', fromIso)
    .lte('at', toIso)
    .order('at', { ascending: false })

  if (error) throw error
  return (data ?? []) as PunchWithBranch[]
}

export async function listApprovedPeriods() {
  const { data, error } = await supabase
    .from('payroll_periods')
    .select('*')
    .eq('status', 'approved')
    .order('year', { ascending: false })
    .order('month', { ascending: false })

  if (error) throw error
  return data ?? []
}

// RLS đảm bảo nhân viên chỉ truy xuất được phiếu lương và phụ cấp của bản thân trong kỳ đã duyệt
export async function getMyPayroll(periodId: string) {
  const userId = await requireCurrentUserId()
  const [payrollRes, allowancesRes] = await Promise.all([
    supabase.from('payroll').select('*').eq('period_id', periodId).eq('employee_id', userId).maybeSingle(),
    supabase.from('monthly_allowances').select('*').eq('period_id', periodId).eq('employee_id', userId).order('created_at', { ascending: true }),
  ])

  if (payrollRes.error) throw payrollRes.error
  if (allowancesRes.error) throw allowancesRes.error

  return { payroll: payrollRes.data, allowances: allowancesRes.data ?? [] }
}

export async function updatePassword(newPassword: string) {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw error
}

export async function changeMyPin(oldPin: string, newPin: string) {
  const { data, error } = await supabase.rpc('change_pin', { p_old_pin: oldPin, p_new_pin: newPin })
  if (error) throw error
  const result = (data ?? {}) as ChangePinResponse
  if (result.error) throw new Error(result.error)
  return result
}
