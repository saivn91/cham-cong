import { supabase } from './supabase';

const WORKER_URL = (import.meta.env.VITE_WORKER_URL ?? '').trim().replace(/\/+$/, '');

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  // Kiểm tra cấu hình: Chặn gọi nhầm vào origin của Vite khi thiếu VITE_WORKER_URL
  if (!WORKER_URL) {
    throw new Error('Thiếu cấu hình môi trường: Cần khai báo VITE_WORKER_URL trong apps/web/.env.local.');
  }

  // Xác thực: Lấy access token từ phiên Supabase và gắn vào header
  const { data: { session } } = await supabase.auth.getSession();
  const headers = new Headers(init?.headers);

  if (session?.access_token) {
    headers.set('Authorization', `Bearer ${session.access_token}`);
  }
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${WORKER_URL}${path}`, {
    ...init,
    headers,
  });

  const body = await response.json().catch(() => ({}));

  // Ranh giới lỗi: Ném Error kèm chi tiết nếu phản hồi không thuộc 2xx
  if (!response.ok) {
    const message = body?.error || response.statusText || 'API Error';
    const details = body?.details ? ` - ${typeof body.details === 'string' ? body.details : JSON.stringify(body.details)}` : '';
    throw new Error(`${message}${details}`);
  }

  return body as T;
}
