import { supabase } from './supabase';

export function subscribeToTable(
  table: string,
  onChange: (payload: unknown) => void
): () => void {
  const channel = supabase
    .channel(`public:${table}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table },
      (payload) => onChange(payload)
    )
    .subscribe();

  // Dọn dẹp kênh đăng ký để tránh rò rỉ bộ nhớ
  return () => {
    supabase.removeChannel(channel);
  };
}
