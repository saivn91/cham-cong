import { useState, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../lib/auth-context';
import { supabase } from '../../lib/supabase';

export const Route = createFileRoute('/admin/branches')({ component: BranchesPage });

type Branch = { id: string; code: string; name: string; address: string | null };
type Manager = { id: string; full_name: string };
type Assignment = { branch_id: string; manager_id: string };

function BranchesPage() {
  const { user, role } = useAuth();
  const qc = useQueryClient();
  const isAdmin = role === 'admin';
  const [form, setForm] = useState({ id: '', code: '', name: '', address: '' });
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  // Query theo user/role: Admin lấy tất cả, Manager chỉ lấy chi nhánh được phân công
  const qKey = ['branches', user?.id, role];
  const { data: branches = [], isLoading, error } = useQuery({
    queryKey: qKey,
    enabled: !!user,
    queryFn: async () => {
      if (isAdmin) {
        const { data, error } = await supabase.from('branches').select('id,code,name,address').order('code');
        if (error) throw error;
        return data as Branch[];
      }
      const { data, error } = await supabase
        .from('manager_branches')
        .select('branches(id,code,name,address)')
        .eq('manager_id', user!.id);
      if (error) throw error;
      return (data?.map((d: any) => d.branches).filter(Boolean) || []) as Branch[];
    },
  });

  const mgrKey = ['active-managers', user?.id];
  const { data: managers = [], isLoading: mgrLoading, error: mgrError } = useQuery({
    queryKey: mgrKey,
    enabled: !!user && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('employees')
        .select('id,full_name')
        .eq('role', 'manager')
        .eq('is_active', true)
        .order('full_name');
      if (error) throw error;
      return (data || []) as Manager[];
    },
  });

  const assignKey = ['manager-branches', user?.id];
  const { data: assignments = [], isLoading: assignLoading, error: assignError } = useQuery({
    queryKey: assignKey,
    enabled: !!user && isAdmin,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('manager_branches')
        .select('branch_id,manager_id');
      if (error) throw error;
      return (data || []) as Assignment[];
    },
  });

  // Mutation thêm hoặc cập nhật chi nhánh (chỉ Admin)
  const saveMut = useMutation({
    mutationFn: async (b: typeof form) => {
      if (!isAdmin) throw new Error('FORBIDDEN');
      const payload = { code: b.code.trim(), name: b.name.trim(), address: b.address.trim() || null };
      if (b.id) {
        const { data, error } = await supabase.from('branches').update(payload).eq('id', b.id).select('id').maybeSingle();
        if (error) throw error;
        if (!data) throw new Error('Không tìm thấy chi nhánh để cập nhật.');
      } else {
        const { error } = await supabase.from('branches').insert(payload);
        if (error) throw error;
      }
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: qKey }); setForm({ id: '', code: '', name: '', address: '' }); setErr(''); setMsg('Đã lưu chi nhánh.'); },
    onError: (e: any) => { setMsg(''); setErr(e.message); },
  });

  // Mutation xóa chi nhánh có xác nhận
  const delMut = useMutation({
    mutationFn: async (id: string) => {
      if (!isAdmin) throw new Error('FORBIDDEN');
      const { data, error } = await supabase.from('branches').delete().eq('id', id).select('id').maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Không tìm thấy chi nhánh để xóa.');
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: qKey }); setErr(''); setMsg('Đã xóa chi nhánh.'); },
    onError: (e: any) => { setMsg(''); setErr(e.message); },
  });

  // Mutation phân công quản lý chi nhánh qua RPC nguyên tử (chỉ Admin)
  const assignMut = useMutation({
    mutationFn: async ({ branchId, managerIds }: { branchId: string; managerIds: string[] }) => {
      if (!isAdmin) throw new Error('FORBIDDEN');
      const { error } = await supabase.rpc('set_branch_managers', {
        p_branch_id: branchId,
        p_manager_ids: managerIds,
      });
      if (error) throw error;
    },
    onSuccess: (_, { branchId }) => {
      setErr('');
      setMsg('Đã cập nhật phân công quản lý.');
      setDrafts(prev => {
        const next = { ...prev };
        delete next[branchId];
        return next;
      });
      qc.invalidateQueries({ queryKey: assignKey });
      qc.invalidateQueries({ queryKey: qKey });
    },
    onError: (e: any) => {
      setMsg('');
      setErr(e.message);
    },
  });

  const toggleManager = (branchId: string, managerId: string, currentIds: string[]) => {
    const next = currentIds.includes(managerId)
      ? currentIds.filter(id => id !== managerId)
      : [...currentIds, managerId];
    setDrafts(prev => ({ ...prev, [branchId]: next }));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!form.code.trim() || !form.name.trim()) return setErr('Mã và tên chi nhánh là bắt buộc.');
    saveMut.mutate(form);
  };

  const pageLoading = isLoading || (isAdmin && (mgrLoading || assignLoading));
  const pageError = error || mgrError || assignError;
  if (pageLoading) return <div className="p-4">Đang tải...</div>;
  if (pageError) return <div className="p-4 text-red-600">Lỗi: {(pageError as any).message}</div>;

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-bold">Quản lý Chi nhánh</h1>
      {err && <div className="p-2 bg-red-100 text-red-700 rounded">{err}</div>}
      {msg && <div className="p-2 bg-green-100 text-green-700 rounded">{msg}</div>}
      {isAdmin && (
        <form onSubmit={onSubmit} className="flex flex-wrap gap-2 items-center bg-gray-50 p-3 rounded border">
          <input className="border p-1.5 rounded" placeholder="Mã *" required value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} />
          <input className="border p-1.5 rounded" placeholder="Tên *" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <input className="border p-1.5 rounded flex-1" placeholder="Địa chỉ" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
          <button type="submit" disabled={saveMut.isPending} className="bg-blue-600 text-white px-3 py-1.5 rounded">
            {form.id ? 'Cập nhật' : 'Thêm'}
          </button>
          {form.id && <button type="button" onClick={() => setForm({ id: '', code: '', name: '', address: '' })} className="px-2 py-1.5 border rounded">Hủy</button>}
        </form>
      )}
      <table className="w-full border-collapse border text-left text-sm">
        <thead>
          <tr className="bg-gray-100 border-b">
            <th className="p-2 border">ID</th><th className="p-2 border">Mã</th><th className="p-2 border">Tên</th><th className="p-2 border">Địa chỉ</th>
            {isAdmin && <th className="p-2 border">Quản lý chi nhánh</th>}
            {isAdmin && <th className="p-2 border w-28">Thao tác</th>}
          </tr>
        </thead>
        <tbody>
          {branches.length === 0 && (
            <tr>
              <td colSpan={isAdmin ? 6 : 4} className="p-4 text-center text-gray-500">Không có chi nhánh nào.</td>
            </tr>
          )}
          {branches.map(b => {
            const assignedIds = assignments.filter(a => a.branch_id === b.id).map(a => a.manager_id);
            const selectedIds = drafts[b.id] ?? assignedIds;
            const assignedNames = assignedIds.map(id => managers.find(m => m.id === id)?.full_name || id);
            const isSavingBranch = assignMut.isPending && assignMut.variables?.branchId === b.id;

            return (
              <tr key={b.id} className="border-b hover:bg-gray-50 align-top">
                <td className="p-2 border font-mono text-xs">{b.id}</td><td className="p-2 border">{b.code}</td><td className="p-2 border">{b.name}</td><td className="p-2 border">{b.address}</td>
                {isAdmin && (
                  <td className="p-2 border space-y-2">
                    <div className="text-xs text-gray-600">
                      <span className="font-semibold">Đang gán: </span>
                      {assignedNames.length > 0 ? assignedNames.join(', ') : 'Chưa phân công'}
                    </div>
                    {managers.length === 0 ? (
                      <div className="text-xs text-gray-400">Không có quản lý đang hoạt động.</div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {managers.map(m => (
                          <label key={m.id} className="inline-flex items-center gap-1 text-xs bg-gray-100 px-2 py-1 rounded border cursor-pointer">
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(m.id)}
                              onChange={() => toggleManager(b.id, m.id, selectedIds)}
                              disabled={isSavingBranch}
                            />
                            <span>{m.full_name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      disabled={isSavingBranch}
                      onClick={() => assignMut.mutate({ branchId: b.id, managerIds: selectedIds })}
                      className="bg-emerald-600 text-white text-xs px-2.5 py-1 rounded disabled:opacity-50"
                    >
                      {isSavingBranch ? 'Đang lưu...' : 'Lưu phân công'}
                    </button>
                  </td>
                )}
                {isAdmin && (
                  <td className="p-2 border space-x-2">
                    <button onClick={() => setForm({ id: b.id, code: b.code, name: b.name, address: b.address || '' })} className="text-blue-600">Sửa</button>
                    <button onClick={() => window.confirm('Xác nhận xóa chi nhánh này?') && delMut.mutate(b.id)} disabled={delMut.isPending} className="text-red-600">Xóa</button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
