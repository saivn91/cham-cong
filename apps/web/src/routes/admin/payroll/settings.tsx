import React, { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Database } from '@timekeeping/shared/database.types';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../lib/auth-context';

type HolidayRow = Database['public']['Tables']['holidays']['Row'];
type HolidayInsert = Database['public']['Tables']['holidays']['Insert'];
type HolidayUpdate = Database['public']['Tables']['holidays']['Update'];
type ShiftTemplateRow = Database['public']['Tables']['shift_templates']['Row'];
type ShiftTemplateInsert = Database['public']['Tables']['shift_templates']['Insert'];
type ShiftTemplateUpdate = Database['public']['Tables']['shift_templates']['Update'];

const FIXED_HOLIDAY_DAY_RATE = 2.0;

// Chuẩn hóa thời gian từ PostgreSQL TIME (HH:MM:SS) về định dạng HH:MM cho input type="time"
const formatTimeHHMM = (timeStr: string) => (timeStr ? timeStr.slice(0, 5) : '');

// Định nghĩa route con cho trang cấu hình ngày lễ và ca mẫu
export const Route = createFileRoute('/admin/payroll/settings')({
  component: PayrollSettingsComponent,
});

function PayrollSettingsComponent() {
  const { role } = useAuth();
  const isAdmin = role === 'admin';
  const queryClient = useQueryClient();

  // State quản lý form thêm/sửa ngày lễ
  const [editingId, setEditingId] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');

  // State quản lý xác nhận xóa và thông báo
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // State quản lý form thêm/sửa ca làm việc mẫu dùng chung (shift_templates)
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  // State quản lý xác nhận xóa và thông báo cho ca mẫu
  const [confirmDeleteTemplateId, setConfirmDeleteTemplateId] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [templateSuccessMsg, setTemplateSuccessMsg] = useState<string | null>(null);

  // Truy vấn danh sách ngày lễ từ Supabase sắp xếp theo ngày tăng dần
  const {
    data: holidays = [],
    isLoading,
    isError,
    error: queryError,
  } = useQuery({
    queryKey: ['holidays'],
    queryFn: async (): Promise<HolidayRow[]> => {
      const { data, error } = await supabase
        .from('holidays')
        .select('id, date, name, rate, created_at')
        .order('date', { ascending: true });

      if (error) throw error;
      return data ?? [];
    },
  });

  // Truy vấn danh sách ca làm việc mẫu dùng chung từ Supabase sắp xếp theo tên ca
  const {
    data: shiftTemplates = [],
    isLoading: isTemplatesLoading,
    isError: isTemplatesError,
    error: templatesError,
  } = useQuery({
    queryKey: ['shift_templates'],
    queryFn: async (): Promise<ShiftTemplateRow[]> => {
      const { data, error } = await supabase
        .from('shift_templates')
        .select('id, name, start_time, end_time, created_at')
        .order('name', { ascending: true });

      if (error) throw error;
      return data ?? [];
    },
  });

  const resetForm = () => {
    setEditingId(null);
    setDate('');
    setName('');
    setFormError(null);
  };

  const resetTemplateForm = () => {
    setEditingTemplateId(null);
    setTemplateName('');
    setStartTime('');
    setEndTime('');
    setTemplateError(null);
  };

  // Mutation thêm mới hoặc cập nhật ngày lễ (luôn ghi rate cố định 2.0 đồng bộ với SQL tính lương)
  const saveMutation = useMutation({
    mutationFn: async (payload: { id: string | null; date: string; name: string }) => {
      if (!isAdmin) throw new Error('Chỉ quản trị viên mới có quyền thay đổi ngày lễ.');
      if (payload.id) {
        const updateData: HolidayUpdate = {
          date: payload.date,
          name: payload.name,
          rate: FIXED_HOLIDAY_DAY_RATE,
        };
        const { error } = await supabase
          .from('holidays')
          .update(updateData)
          .eq('id', payload.id);
        if (error) throw error;
      } else {
        const insertData: HolidayInsert = {
          date: payload.date,
          name: payload.name,
          rate: FIXED_HOLIDAY_DAY_RATE,
        };
        const { error } = await supabase.from('holidays').insert(insertData);
        if (error) throw error;
      }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
      setSuccessMsg(variables.id ? 'Cập nhật ngày lễ thành công.' : 'Thêm ngày lễ mới thành công.');
      resetForm();
    },
    onError: (err: Error) => {
      setSuccessMsg(null);
      setFormError(err.message || 'Không thể lưu ngày lễ. Vui lòng kiểm tra lại (có thể trùng ngày).');
    },
  });

  // Mutation xóa ngày lễ
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!isAdmin) throw new Error('Chỉ quản trị viên mới có quyền xóa ngày lễ.');
      const { error } = await supabase.from('holidays').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['holidays'] });
      setConfirmDeleteId(null);
      setFormError(null);
      setSuccessMsg('Đã xóa ngày lễ thành công.');
      if (editingId === deletedId) {
        resetForm();
      }
    },
    onError: (err: Error) => {
      setSuccessMsg(null);
      setFormError(err.message || 'Không thể xóa ngày lễ.');
    },
  });

  // Mutation thêm mới hoặc cập nhật ca làm việc mẫu dùng chung (chỉ admin có quyền ghi)
  const saveTemplateMutation = useMutation({
    mutationFn: async (payload: {
      id: string | null;
      name: string;
      start_time: string;
      end_time: string;
    }) => {
      if (!isAdmin) throw new Error('Chỉ quản trị viên mới có quyền thay đổi ca mẫu.');
      if (payload.id) {
        const updateData: ShiftTemplateUpdate = {
          name: payload.name,
          start_time: payload.start_time,
          end_time: payload.end_time,
        };
        const { data, error } = await supabase
          .from('shift_templates')
          .update(updateData)
          .eq('id', payload.id)
          .select('id')
          .maybeSingle();
        if (error) throw error;
        if (!data) throw new Error('Không tìm thấy ca mẫu để cập nhật.');
      } else {
        const insertData: ShiftTemplateInsert = {
          name: payload.name,
          start_time: payload.start_time,
          end_time: payload.end_time,
        };
        const { error } = await supabase.from('shift_templates').insert(insertData);
        if (error) throw error;
      }
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['shift_templates'] });
      setTemplateSuccessMsg(
        variables.id ? 'Cập nhật ca mẫu thành công.' : 'Thêm ca mẫu mới thành công.'
      );
      resetTemplateForm();
    },
    onError: (err: Error) => {
      setTemplateSuccessMsg(null);
      setTemplateError(err.message || 'Không thể lưu ca mẫu. Vui lòng kiểm tra lại.');
    },
  });

  // Mutation xóa ca làm việc mẫu
  const deleteTemplateMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!isAdmin) throw new Error('Chỉ quản trị viên mới có quyền xóa ca mẫu.');
      const { data, error } = await supabase
        .from('shift_templates')
        .delete()
        .eq('id', id)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Không tìm thấy ca mẫu để xóa.');
    },
    onSuccess: (_, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ['shift_templates'] });
      setConfirmDeleteTemplateId(null);
      setTemplateError(null);
      setTemplateSuccessMsg('Đã xóa ca mẫu thành công.');
      if (editingTemplateId === deletedId) {
        resetTemplateForm();
      }
    },
    onError: (err: Error) => {
      setTemplateSuccessMsg(null);
      setTemplateError(err.message || 'Không thể xóa ca mẫu.');
    },
  });

  // Kiểm tra dữ liệu đầu vào trước khi gửi lên Supabase
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSuccessMsg(null);

    if (!isAdmin) {
      setFormError('Chỉ quản trị viên mới có quyền thay đổi ngày lễ.');
      return;
    }

    const trimmedDate = date.trim();
    const trimmedName = name.trim();

    if (!trimmedDate || !/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
      setFormError('Vui lòng chọn ngày lễ hợp lệ (YYYY-MM-DD).');
      return;
    }

    if (!trimmedName) {
      setFormError('Vui lòng nhập tên ngày lễ.');
      return;
    }

    saveMutation.mutate({
      id: editingId,
      date: trimmedDate,
      name: trimmedName,
    });
  };

  const handleEditClick = (holiday: HolidayRow) => {
    setEditingId(holiday.id);
    setDate(holiday.date);
    setName(holiday.name);
    setFormError(null);
    setSuccessMsg(null);
    setConfirmDeleteId(null);
  };

  // Kiểm tra dữ liệu ca mẫu trước khi lưu (hỗ trợ cả ca qua đêm khi giờ kết thúc nhỏ hơn giờ bắt đầu)
  const handleTemplateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTemplateError(null);
    setTemplateSuccessMsg(null);

    if (!isAdmin) {
      setTemplateError('Chỉ quản trị viên mới có quyền thay đổi ca mẫu.');
      return;
    }

    const trimmedName = templateName.trim();
    const trimmedStart = formatTimeHHMM(startTime.trim());
    const trimmedEnd = formatTimeHHMM(endTime.trim());
    const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

    if (!trimmedName) {
      setTemplateError('Vui lòng nhập tên ca mẫu.');
      return;
    }

    if (!timeRegex.test(trimmedStart) || !timeRegex.test(trimmedEnd)) {
      setTemplateError('Vui lòng nhập giờ bắt đầu và kết thúc hợp lệ (HH:MM).');
      return;
    }

    if (trimmedStart === trimmedEnd) {
      setTemplateError('Giờ bắt đầu và giờ kết thúc không được trùng nhau.');
      return;
    }

    saveTemplateMutation.mutate({
      id: editingTemplateId,
      name: trimmedName,
      start_time: trimmedStart,
      end_time: trimmedEnd,
    });
  };

  const handleEditTemplateClick = (tpl: ShiftTemplateRow) => {
    setEditingTemplateId(tpl.id);
    setTemplateName(tpl.name);
    setStartTime(formatTimeHHMM(tpl.start_time));
    setEndTime(formatTimeHHMM(tpl.end_time));
    setTemplateError(null);
    setTemplateSuccessMsg(null);
    setConfirmDeleteTemplateId(null);
  };

  // Sắp xếp danh sách ca làm việc mẫu dùng chung theo tên chuẩn tiếng Việt
  const sortedShiftTemplates = [...shiftTemplates].sort((a, b) =>
    a.name.localeCompare(b.name, 'vi')
  );

  return (
    <div className="space-y-6">
      {/* Thông báo lỗi hoặc thành công */}
      {formError && (
        <div className="rounded-md bg-red-50 border border-red-200 p-4 text-sm text-red-700">
          {formError}
        </div>
      )}
      {successMsg && (
        <div className="rounded-md bg-green-50 border border-green-200 p-4 text-sm text-green-700">
          {successMsg}
        </div>
      )}

      {/* Biểu mẫu thêm / chỉnh sửa ngày lễ */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">
          {editingId ? 'Chỉnh sửa ngày lễ' : 'Thêm ngày lễ mới'}
        </h3>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-start">
          <div>
            <label htmlFor="holiday-date" className="block text-sm font-medium text-gray-700 mb-1">
              Ngày lễ <span className="text-red-500">*</span>
            </label>
            <input
              id="holiday-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={!isAdmin || saveMutation.isPending}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-100"
              required
            />
          </div>

          <div className="md:col-span-2">
            <label htmlFor="holiday-name" className="block text-sm font-medium text-gray-700 mb-1">
              Tên ngày lễ <span className="text-red-500">*</span>
            </label>
            <input
              id="holiday-name"
              type="text"
              placeholder="VD: Tết Dương lịch, Quốc khánh 2/9..."
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!isAdmin || saveMutation.isPending}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-100"
              required
            />
          </div>

          <div>
            <span className="block text-sm font-medium text-gray-700 mb-1">
              Hệ số lương áp dụng (Cố định)
            </span>
            <div className="w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm font-medium text-gray-800">
              Ban ngày: 2.0 (200%)
            </div>
            <p className="mt-1 text-xs text-gray-500">
              Ca đêm ngày lễ áp dụng hệ số cố định 2.3 (230%) theo công thức tính lương hệ thống.
            </p>
          </div>

          <div className="md:col-span-4 flex items-center gap-2 pt-2">
            <button
              type="submit"
              disabled={!isAdmin || saveMutation.isPending}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saveMutation.isPending
                ? 'Đang lưu...'
                : editingId
                  ? 'Cập nhật ngày lễ'
                  : 'Thêm ngày lễ'}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                disabled={saveMutation.isPending}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Hủy chỉnh sửa
              </button>
            )}
          </div>
        </form>
      </div>

      {/* Bảng danh sách ngày lễ */}
      <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-800">Danh sách ngày nghỉ lễ</h3>
          <span className="text-xs text-gray-500">Tổng số: {holidays.length} ngày lễ</span>
        </div>

        {isLoading ? (
          <div className="p-6 text-sm text-gray-500">Đang tải danh sách ngày lễ...</div>
        ) : isError ? (
          <div className="p-6 text-sm text-red-600">
            Lỗi tải dữ liệu ngày lễ: {(queryError as Error)?.message || 'Không xác định'}
          </div>
        ) : holidays.length === 0 ? (
          <div className="p-6 text-sm text-gray-500">
            Chưa có ngày nghỉ lễ nào được cấu hình.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left font-medium text-gray-600">Ngày (YYYY-MM-DD)</th>
                  <th className="px-6 py-3 text-left font-medium text-gray-600">Tên ngày lễ</th>
                  <th className="px-6 py-3 text-left font-medium text-gray-600">Hệ số lương (Ngày / Đêm)</th>
                  <th className="px-6 py-3 text-right font-medium text-gray-600">Thao tác</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 bg-white">
                {holidays.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="px-6 py-3 font-mono text-gray-800 whitespace-nowrap">{item.date}</td>
                    <td className="px-6 py-3 text-gray-800 font-medium">{item.name}</td>
                    <td className="px-6 py-3 text-gray-700 whitespace-nowrap space-x-1.5">
                      <span className="inline-flex items-center rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                        Ngày: 2.0 (200%)
                      </span>
                      <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700">
                        Đêm: 2.3 (230%)
                      </span>
                    </td>
                    <td className="px-6 py-3 text-right whitespace-nowrap space-x-2">
                      <button
                        type="button"
                        onClick={() => handleEditClick(item)}
                        disabled={!isAdmin || deleteMutation.isPending}
                        className="text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50"
                      >
                        Sửa
                      </button>
                      {confirmDeleteId === item.id ? (
                        <span className="inline-flex items-center space-x-2 pl-2">
                          <button
                            type="button"
                            onClick={() => deleteMutation.mutate(item.id)}
                            disabled={!isAdmin || deleteMutation.isPending}
                            className="rounded bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                          >
                            {deleteMutation.isPending ? 'Đang xóa...' : 'Xác nhận xóa'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            disabled={deleteMutation.isPending}
                            className="rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
                          >
                            Hủy
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmDeleteId(item.id);
                            setFormError(null);
                            setSuccessMsg(null);
                          }}
                          disabled={!isAdmin}
                          className="text-red-600 hover:text-red-800 font-medium disabled:opacity-50"
                        >
                          Xóa
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Khu vực cấu hình ca làm việc mẫu (Shift Templates) */}
      <div className="pt-4 border-t border-gray-200 space-y-6">
        {templateError && (
          <div className="rounded-md bg-red-50 border border-red-200 p-4 text-sm text-red-700">
            {templateError}
          </div>
        )}
        {templateSuccessMsg && (
          <div className="rounded-md bg-green-50 border border-green-200 p-4 text-sm text-green-700">
            {templateSuccessMsg}
          </div>
        )}

        {/* Biểu mẫu thêm / chỉnh sửa ca mẫu dùng chung */}
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <div className="mb-4">
            <h3 className="text-lg font-semibold text-gray-800">
              {editingTemplateId
                ? 'Chỉnh sửa ca làm việc mẫu (Dùng chung)'
                : 'Thêm ca làm việc mẫu (Dùng chung)'}
            </h3>
            <p className="mt-1 text-xs text-gray-500">
              Ca làm việc mẫu là danh mục dùng chung cho toàn bộ chi nhánh trong hệ thống.
            </p>
          </div>
          <form
            onSubmit={handleTemplateSubmit}
            className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start"
          >
            <div>
              <label
                htmlFor="template-name"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Tên ca mẫu <span className="text-red-500">*</span>
              </label>
              <input
                id="template-name"
                type="text"
                placeholder="VD: Ca sáng, Ca tối, Ca đêm..."
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
                disabled={!isAdmin || saveTemplateMutation.isPending}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-100"
                required
              />
            </div>

            <div>
              <label
                htmlFor="template-start-time"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Giờ bắt đầu <span className="text-red-500">*</span>
              </label>
              <input
                id="template-start-time"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                disabled={!isAdmin || saveTemplateMutation.isPending}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-100"
                required
              />
            </div>

            <div>
              <label
                htmlFor="template-end-time"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Giờ kết thúc <span className="text-red-500">*</span>
              </label>
              <input
                id="template-end-time"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                disabled={!isAdmin || saveTemplateMutation.isPending}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-100"
                required
              />
              <p className="mt-1 text-xs text-gray-500">
                Nếu giờ kết thúc nhỏ hơn giờ bắt đầu, hệ thống tính là ca qua đêm.
              </p>
            </div>

            <div className="md:col-span-3 flex items-center gap-2 pt-2">
              <button
                type="submit"
                disabled={!isAdmin || saveTemplateMutation.isPending}
                className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saveTemplateMutation.isPending
                  ? 'Đang lưu...'
                  : editingTemplateId
                    ? 'Cập nhật ca mẫu'
                    : 'Thêm ca mẫu'}
              </button>
              {editingTemplateId && (
                <button
                  type="button"
                  onClick={resetTemplateForm}
                  disabled={saveTemplateMutation.isPending}
                  className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Hủy chỉnh sửa
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Bảng danh sách ca làm việc mẫu dùng chung */}
        <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-gray-800">
                Danh sách ca làm việc mẫu (Dùng chung)
              </h3>
              <p className="text-xs text-gray-500">
                Áp dụng chung cho tất cả chi nhánh khi phân ca làm việc
              </p>
            </div>
            <span className="text-xs text-gray-500">Tổng số: {sortedShiftTemplates.length} ca mẫu</span>
          </div>

          {isTemplatesLoading ? (
            <div className="p-6 text-sm text-gray-500">Đang tải danh sách ca làm việc mẫu...</div>
          ) : isTemplatesError ? (
            <div className="p-6 text-sm text-red-600">
              Lỗi tải dữ liệu ca mẫu: {(templatesError as Error)?.message || 'Không xác định'}
            </div>
          ) : sortedShiftTemplates.length === 0 ? (
            <div className="p-6 text-sm text-gray-500">
              Chưa có ca làm việc mẫu nào được cấu hình.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left font-medium text-gray-600">Tên ca mẫu</th>
                    <th className="px-6 py-3 text-left font-medium text-gray-600">Khung giờ (Bắt đầu - Kết thúc)</th>
                    <th className="px-6 py-3 text-right font-medium text-gray-600">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {sortedShiftTemplates.map((tpl) => {
                    const start = formatTimeHHMM(tpl.start_time);
                    const end = formatTimeHHMM(tpl.end_time);
                    const isOvernight = start > end;

                    return (
                      <tr key={tpl.id} className="hover:bg-gray-50">
                        <td className="px-6 py-3 text-gray-800 font-medium">{tpl.name}</td>
                        <td className="px-6 py-3 text-gray-700 whitespace-nowrap space-x-2">
                          <span className="font-mono">
                            {start} - {end}
                          </span>
                          {isOvernight && (
                            <span className="inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
                              Qua đêm (+1 ngày)
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-3 text-right whitespace-nowrap space-x-2">
                          <button
                            type="button"
                            onClick={() => handleEditTemplateClick(tpl)}
                            disabled={!isAdmin || deleteTemplateMutation.isPending}
                            className="text-blue-600 hover:text-blue-800 font-medium disabled:opacity-50"
                          >
                            Sửa
                          </button>
                          {confirmDeleteTemplateId === tpl.id ? (
                            <span className="inline-flex items-center space-x-2 pl-2">
                              <button
                                type="button"
                                onClick={() => deleteTemplateMutation.mutate(tpl.id)}
                                disabled={!isAdmin || deleteTemplateMutation.isPending}
                                className="rounded bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                              >
                                {deleteTemplateMutation.isPending ? 'Đang xóa...' : 'Xác nhận xóa'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteTemplateId(null)}
                                disabled={deleteTemplateMutation.isPending}
                                className="rounded border border-gray-300 bg-white px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
                              >
                                Hủy
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setConfirmDeleteTemplateId(tpl.id);
                                setTemplateError(null);
                                setTemplateSuccessMsg(null);
                              }}
                              disabled={!isAdmin}
                              className="text-red-600 hover:text-red-800 font-medium disabled:opacity-50"
                            >
                              Xóa
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
