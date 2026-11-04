import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../lib/auth-context';
import { supabase } from '../../lib/supabase';

export const Route = createFileRoute('/admin/audit')({
  component: AuditLogPage,
});

const PAGE_SIZE = 25;

type AuditLogRow = {
  id: string;
  table_name: string;
  row_id: string;
  action: string;
  old_data: unknown | null;
  new_data: unknown | null;
  actor_id: string | null;
  branch_id: string | null;
  created_at: string;
};

// Chuyển đổi dữ liệu JSON sang chuỗi an toàn để hiển thị
function safeFormatJson(data: unknown): string {
  if (data === null || data === undefined) return '';
  try {
    return typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function JsonExpandablePanel({ label, data }: { label: string; data: unknown }) {
  if (data === null || data === undefined) {
    return <span className="text-gray-400 italic text-xs">Không có</span>;
  }
  const formatted = safeFormatJson(data);
  return (
    <details className="group text-xs">
      <summary className="cursor-pointer text-blue-600 hover:underline font-medium select-none">
        {label}
      </summary>
      <pre className="mt-1.5 p-2 bg-gray-900 text-gray-100 rounded overflow-x-auto max-h-60 max-w-md font-mono text-xs leading-relaxed">
        {formatted}
      </pre>
    </details>
  );
}

function AuditLogPage() {
  const { user, role } = useAuth();
  const [actionFilter, setActionFilter] = useState('');
  const [tableFilter, setTableFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [page, setPage] = useState(0);

  // Truy vấn phân trang nhật ký kiểm toán; phạm vi dữ liệu của Manager được kiểm soát trực tiếp bởi RLS
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['audit_log', user?.id, role, actionFilter, tableFilter, dateFilter, page],
    enabled: !!user && (role === 'admin' || role === 'manager'),
    queryFn: async () => {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let query = supabase
        .from('audit_log')
        .select('id,table_name,row_id,action,old_data,new_data,actor_id,branch_id,created_at', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      if (actionFilter.trim()) {
        query = query.ilike('action', `%${actionFilter.trim()}%`);
      }
      if (tableFilter.trim()) {
        query = query.ilike('table_name', `%${tableFilter.trim()}%`);
      }
      if (dateFilter) {
        const startOfDay = new Date(`${dateFilter}T00:00:00.000+07:00`).toISOString();
        const endOfDay = new Date(`${dateFilter}T23:59:59.999+07:00`).toISOString();
        query = query.gte('created_at', startOfDay).lte('created_at', endOfDay);
      }

      const { data: rows, error: queryError, count } = await query;
      if (queryError) throw queryError;

      return {
        rows: (rows ?? []) as AuditLogRow[],
        count: count ?? 0,
      };
    },
  });

  const rows = data?.rows ?? [];
  const totalCount = data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const handleResetFilters = () => {
    setActionFilter('');
    setTableFilter('');
    setDateFilter('');
    setPage(0);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-800">Nhật ký hệ thống (Audit Log)</h1>
          <p className="text-xs text-gray-500">
            {role === 'admin'
              ? 'Phạm vi: Toàn hệ thống (Admin)'
              : 'Phạm vi: Chi nhánh được phân công (Manager - áp dụng qua RLS)'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {isFetching ? 'Đang làm mới...' : 'Làm mới'}
        </button>
      </div>

      <div className="flex flex-wrap gap-3 items-end bg-white p-3 rounded border">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Hành động</label>
          <input
            type="text"
            placeholder="vd: correct_punch, void_punch..."
            value={actionFilter}
            onChange={e => {
              setActionFilter(e.target.value);
              setPage(0);
            }}
            className="border p-1.5 rounded text-sm"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Tên bảng</label>
          <input
            type="text"
            placeholder="vd: punches, employees..."
            value={tableFilter}
            onChange={e => {
              setTableFilter(e.target.value);
              setPage(0);
            }}
            className="border p-1.5 rounded text-sm"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Ngày ghi nhận</label>
          <input
            type="date"
            value={dateFilter}
            onChange={e => {
              setDateFilter(e.target.value);
              setPage(0);
            }}
            className="border p-1.5 rounded text-sm"
          />
        </div>

        {(actionFilter || tableFilter || dateFilter) && (
          <button
            type="button"
            onClick={handleResetFilters}
            className="px-3 py-1.5 border rounded text-sm text-gray-700 hover:bg-gray-100"
          >
            Xóa bộ lọc
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 bg-red-100 text-red-700 rounded text-sm">
          Lỗi tải nhật ký: {(error as Error).message}
        </div>
      )}

      {isLoading ? (
        <div className="p-6 text-center text-gray-600 bg-white rounded border">Đang tải dữ liệu nhật ký...</div>
      ) : (
        <div className="bg-white rounded border overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="bg-gray-100 border-b text-gray-700">
                <th className="p-2.5 border">Thời gian</th>
                <th className="p-2.5 border">Hành động</th>
                <th className="p-2.5 border">Bảng / Bản ghi</th>
                <th className="p-2.5 border">Người thực hiện (Actor)</th>
                <th className="p-2.5 border">Chi nhánh (Branch)</th>
                <th className="p-2.5 border">Dữ liệu cũ</th>
                <th className="p-2.5 border">Dữ liệu mới</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-6 text-center text-gray-500">
                    Không có bản ghi nhật ký nào phù hợp.
                  </td>
                </tr>
              ) : (
                rows.map(row => (
                  <tr key={row.id} className="border-b hover:bg-gray-50 align-top">
                    <td className="p-2.5 border whitespace-nowrap text-xs text-gray-700">
                      {new Date(row.created_at).toLocaleString('vi-VN')}
                    </td>
                    <td className="p-2.5 border whitespace-nowrap">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                          row.action === 'INSERT'
                            ? 'bg-green-100 text-green-800'
                            : row.action === 'UPDATE'
                              ? 'bg-blue-100 text-blue-800'
                              : row.action === 'DELETE'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-gray-100 text-gray-800'
                        }`}
                      >
                        {row.action}
                      </span>
                    </td>
                    <td className="p-2.5 border">
                      <div className="font-medium text-gray-800">{row.table_name}</div>
                      <div className="font-mono text-xs text-gray-500 break-all">{row.row_id}</div>
                    </td>
                    <td className="p-2.5 border font-mono text-xs text-gray-700 break-all">
                      {row.actor_id ?? <span className="text-gray-400 italic">Hệ thống</span>}
                    </td>
                    <td className="p-2.5 border font-mono text-xs text-gray-700 break-all">
                      {row.branch_id ?? <span className="text-gray-400 italic">-</span>}
                    </td>
                    <td className="p-2.5 border">
                      <JsonExpandablePanel label="Xem JSON cũ" data={row.old_data} />
                    </td>
                    <td className="p-2.5 border">
                      <JsonExpandablePanel label="Xem JSON mới" data={row.new_data} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-700 bg-white p-3 rounded border">
        <div>
          Tổng số: <span className="font-semibold">{totalCount}</span> bản ghi (Hiển thị tối đa {PAGE_SIZE} bản ghi/trang)
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0 || isLoading || isFetching}
            className="px-3 py-1 border rounded hover:bg-gray-100 disabled:opacity-50"
          >
            Trang trước
          </button>
          <span>
            Trang <span className="font-semibold">{page + 1}</span> / {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage(p => (p + 1 < totalPages ? p + 1 : p))}
            disabled={page + 1 >= totalPages || isLoading || isFetching}
            className="px-3 py-1 border rounded hover:bg-gray-100 disabled:opacity-50"
          >
            Trang sau
          </button>
        </div>
      </div>
    </div>
  );
}
