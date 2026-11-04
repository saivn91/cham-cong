import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../lib/auth-context'
import { listApprovedPeriods, getMyPayroll } from '../../lib/employee'

export const Route = createFileRoute('/app/payroll')({
  component: PayrollPage,
})

const currencyFormatter = new Intl.NumberFormat('vi-VN', {
  style: 'currency',
  currency: 'VND',
  maximumFractionDigits: 0,
})

function formatVnd(amount: number): string {
  return currencyFormatter.format(amount)
}

function formatMinutesDetail(minutes: number): string {
  const safeMinutes = Number.isFinite(minutes) ? minutes : 0
  const hours = Math.floor(safeMinutes / 60)
  const mins = safeMinutes % 60
  const decimalHours = (safeMinutes / 60).toFixed(2)
  return `${safeMinutes} phút (${hours}g ${mins}p • ${decimalHours} giờ)`
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function PayrollPage() {
  const { user } = useAuth()
  const userId = user?.id

  const [selectedPeriodId, setSelectedPeriodId] = useState<string>('')

  // Truy vấn danh sách các kỳ lương đã được phê duyệt (query key gắn với userId để cô lập cache theo từng nhân viên)
  const periodsQuery = useQuery({
    queryKey: ['approved-periods', userId],
    queryFn: () => listApprovedPeriods(),
    enabled: Boolean(userId),
  })

  const periods = periodsQuery.data ?? []

  // Mặc định chọn kỳ lương đã duyệt mới nhất nếu người dùng chưa chọn thủ công
  const activePeriodId =
    periods.some((p) => p.id === selectedPeriodId)
      ? selectedPeriodId
      : (periods[0]?.id ?? '')

  const activePeriod = periods.find((p) => p.id === activePeriodId) ?? null

  // Truy vấn phiếu lương và danh sách phụ cấp tháng của nhân viên trong kỳ đã chọn
  const payrollQuery = useQuery({
    queryKey: ['my-payroll', userId, activePeriodId],
    queryFn: () => getMyPayroll(activePeriodId),
    enabled: Boolean(userId && activePeriodId),
  })

  const payroll = payrollQuery.data?.payroll ?? null
  const allowances = payrollQuery.data?.allowances ?? []

  // Danh sách đầy đủ 6 nhóm số phút làm việc theo đúng schema bảng payroll
  const minuteCategories = payroll
    ? [
        {
          key: 'minutes_regular_day',
          label: 'Giờ thường - Ban ngày',
          description: 'Số phút làm việc ngày thường trong khung giờ ngày',
          minutes: payroll.minutes_regular_day,
        },
        {
          key: 'minutes_regular_night',
          label: 'Giờ thường - Ban đêm',
          description: 'Số phút làm việc ngày thường trong khung giờ đêm',
          minutes: payroll.minutes_regular_night,
        },
        {
          key: 'minutes_ot_day',
          label: 'Tăng ca (OT) - Ban ngày',
          description: 'Số phút làm thêm giờ ngày thường trong khung giờ ngày',
          minutes: payroll.minutes_ot_day,
        },
        {
          key: 'minutes_ot_night',
          label: 'Tăng ca (OT) - Ban đêm',
          description: 'Số phút làm thêm giờ ngày thường trong khung giờ đêm',
          minutes: payroll.minutes_ot_night,
        },
        {
          key: 'minutes_holiday_day',
          label: 'Ngày lễ - Ban ngày',
          description: 'Số phút làm việc vào ngày nghỉ lễ trong khung giờ ngày',
          minutes: payroll.minutes_holiday_day,
        },
        {
          key: 'minutes_holiday_night',
          label: 'Ngày lễ - Ban đêm',
          description: 'Số phút làm việc vào ngày nghỉ lễ trong khung giờ đêm',
          minutes: payroll.minutes_holiday_night,
        },
      ]
    : []

  const totalMinutes = minuteCategories.reduce((sum, item) => sum + item.minutes, 0)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Phiếu lương của tôi</h1>
          <p className="text-sm text-slate-600">
            Xem chi tiết giờ công, mức lương chốt kỳ, phụ cấp và tổng lương các kỳ đã duyệt.
          </p>
        </div>

        {periods.length > 0 && (
          <div className="flex items-center gap-2">
            <label htmlFor="period-select" className="text-sm font-medium text-slate-700 whitespace-nowrap">
              Kỳ lương:
            </label>
            <select
              id="period-select"
              value={activePeriodId}
              onChange={(e) => setSelectedPeriodId(e.target.value)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/20"
            >
              {periods.map((period) => (
                <option key={period.id} value={period.id}>
                  Tháng {String(period.month).padStart(2, '0')}/{period.year}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Trạng thái đang tải danh sách kỳ lương */}
      {periodsQuery.isLoading && (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="text-sm text-slate-600">Đang tải danh sách kỳ lương đã duyệt...</p>
        </div>
      )}

      {/* Trạng thái lỗi khi tải danh sách kỳ lương */}
      {periodsQuery.isError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Không thể tải danh sách kỳ lương:{' '}
              {periodsQuery.error instanceof Error ? periodsQuery.error.message : 'Đã xảy ra lỗi.'}
            </span>
            <button
              type="button"
              onClick={() => periodsQuery.refetch()}
              className="self-start rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 sm:self-auto"
            >
              Thử lại
            </button>
          </div>
        </div>
      )}

      {/* Trạng thái rỗng khi chưa có kỳ lương nào được phê duyệt */}
      {!periodsQuery.isLoading && !periodsQuery.isError && periods.length === 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <p className="text-base font-medium text-slate-800">Chưa có kỳ lương nào được phê duyệt</p>
          <p className="mt-1 text-sm text-slate-500">
            Phiếu lương sẽ hiển thị tại đây sau khi quản trị viên hoàn tất chốt và phê duyệt kỳ lương.
          </p>
        </div>
      )}

      {/* Nội dung chi tiết khi đã có kỳ lương được chọn */}
      {activePeriod && (
        <>
          {payrollQuery.isLoading && (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <p className="text-sm text-slate-600">
                Đang tải phiếu lương tháng {String(activePeriod.month).padStart(2, '0')}/{activePeriod.year}...
              </p>
            </div>
          )}

          {payrollQuery.isError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span>
                  Không thể tải chi tiết phiếu lương:{' '}
                  {payrollQuery.error instanceof Error ? payrollQuery.error.message : 'Đã xảy ra lỗi.'}
                </span>
                <button
                  type="button"
                  onClick={() => payrollQuery.refetch()}
                  className="self-start rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 sm:self-auto"
                >
                  Thử lại
                </button>
              </div>
            </div>
          )}

          {!payrollQuery.isLoading && !payrollQuery.isError && !payroll && (
            <div className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <p className="text-base font-medium text-slate-800">
                Không có phiếu lương trong kỳ tháng {String(activePeriod.month).padStart(2, '0')}/{activePeriod.year}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                Bạn không có dữ liệu tính lương được ghi nhận trong kỳ lương đã duyệt này.
              </p>
            </div>
          )}

          {!payrollQuery.isLoading && !payrollQuery.isError && payroll && (
            <div className="space-y-6">
              {/* Khối tổng quan lương thực nhận và các chỉ số tại thời điểm chốt lương */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl border border-blue-200 bg-blue-50/70 p-4 shadow-sm">
                  <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">
                    Tổng lương
                  </p>
                  <p className="mt-2 text-2xl font-bold text-blue-900">
                    {formatVnd(payroll.total_salary)}
                  </p>
                  <p className="mt-1 text-xs text-blue-700">
                    Kỳ tháng {String(activePeriod.month).padStart(2, '0')}/{activePeriod.year}
                  </p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Đơn giá giờ chốt kỳ
                  </p>
                  <p className="mt-2 text-xl font-bold text-slate-900">
                    {formatVnd(payroll.hourly_rate_snapshot)}
                    <span className="text-xs font-normal text-slate-500"> / giờ</span>
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Mức lương giờ áp dụng khi chốt kỳ</p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Phụ cấp cố định chốt kỳ
                  </p>
                  <p className="mt-2 text-xl font-bold text-slate-900">
                    {formatVnd(payroll.fixed_allowance_snapshot)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Mức phụ cấp cố định khi chốt kỳ</p>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Tổng phụ cấp trong kỳ
                  </p>
                  <p className="mt-2 text-xl font-bold text-emerald-700">
                    {formatVnd(payroll.total_allowance)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">Gồm phụ cấp cố định và điều chỉnh tháng</p>
                </div>
              </div>

              {/* Thông tin thời điểm tính và phê duyệt */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                <span>
                  Thời điểm tính lương: <strong className="text-slate-800">{formatDateTime(payroll.calculated_at)}</strong>
                </span>
                <span>
                  Thời điểm duyệt kỳ lương:{' '}
                  <strong className="text-slate-800">{formatDateTime(activePeriod.approved_at)}</strong>
                </span>
              </div>

              {/* Bảng chi tiết 6 nhóm số phút làm việc */}
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-col gap-1 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      Chi tiết thời gian làm việc (6 nhóm giờ công)
                    </h2>
                    <p className="text-xs text-slate-500">
                      Tổng hợp số phút làm việc thực tế đã được phân loại trong kỳ
                    </p>
                  </div>
                  <div className="text-sm font-medium text-slate-700">
                    Tổng cộng: <span className="font-bold text-slate-900">{formatMinutesDetail(totalMinutes)}</span>
                  </div>
                </div>

                <div className="divide-y divide-slate-200">
                  {minuteCategories.map((category) => (
                    <div
                      key={category.key}
                      className="flex flex-col justify-between gap-2 px-5 py-3.5 sm:flex-row sm:items-center"
                    >
                      <div>
                        <p className="text-sm font-medium text-slate-900">{category.label}</p>
                        <p className="text-xs text-slate-500">{category.description}</p>
                      </div>
                      <div className="text-sm font-semibold text-slate-900 sm:text-right">
                        {formatMinutesDetail(category.minutes)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Danh sách phụ cấp và điều chỉnh tháng */}
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <div className="flex flex-col gap-1 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-slate-900">
                      Chi tiết phụ cấp & điều chỉnh trong kỳ
                    </h2>
                    <p className="text-xs text-slate-500">
                      Bao gồm phụ cấp cố định chốt kỳ và các khoản phụ cấp theo tháng
                    </p>
                  </div>
                  <div className="text-sm font-medium text-slate-700">
                    Tổng phụ cấp:{' '}
                    <span className="font-bold text-emerald-700">{formatVnd(payroll.total_allowance)}</span>
                  </div>
                </div>

                <div className="divide-y divide-slate-200">
                  {/* Dòng hiển thị phụ cấp cố định chốt kỳ */}
                  <div className="flex flex-col justify-between gap-2 bg-slate-50/60 px-5 py-3.5 sm:flex-row sm:items-center">
                    <div>
                      <p className="text-sm font-medium text-slate-900">Phụ cấp cố định chốt kỳ</p>
                      <p className="text-xs text-slate-500">Mức phụ cấp cố định áp dụng tại thời điểm chốt lương</p>
                    </div>
                    <div className="text-sm font-semibold text-slate-900 sm:text-right">
                      {formatVnd(payroll.fixed_allowance_snapshot)}
                    </div>
                  </div>

                  {/* Danh sách các khoản phụ cấp tháng */}
                  {allowances.length === 0 ? (
                    <div className="px-5 py-6 text-center text-sm text-slate-500">
                      Không có khoản phụ cấp hoặc điều chỉnh phát sinh thêm trong kỳ lương này.
                    </div>
                  ) : (
                    allowances.map((item) => (
                      <div
                        key={item.id}
                        className="flex flex-col justify-between gap-2 px-5 py-3.5 sm:flex-row sm:items-center"
                      >
                        <div>
                          <p className="text-sm font-medium text-slate-900">
                            {item.reason?.trim() ? item.reason : 'Không có lý do ghi chú'}
                          </p>
                          <p className="text-xs text-slate-500">
                            Ghi nhận lúc: {formatDateTime(item.created_at)}
                          </p>
                        </div>
                        <div
                          className={`text-sm font-semibold sm:text-right ${
                            item.amount < 0 ? 'text-red-600' : 'text-emerald-700'
                          }`}
                        >
                          {item.amount > 0 ? `+${formatVnd(item.amount)}` : formatVnd(item.amount)}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
