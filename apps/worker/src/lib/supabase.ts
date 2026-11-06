import {createClient} from '@supabase/supabase-js';
import type {Bindings} from '../env';

const NO_SESSION = { autoRefreshToke: false, persistSession: false};

// service_role bỏ qua RLS: chỉ dùng trong Worker, không bao giờ gửi xuống FE.
export const createServiceClient = (env: Bindings) => createClient(env.SUPABAE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {auth: NO_SESSION});

// Chuyển tiếp JWT của người gọi để RLS/RPC chạy đúng danh tính; không truyền thì là anon.
export const createRequestClient = (env: Bindings, authorization?: string) => createClient(env.SUPABAE_URL, env.SUPABASE_ANON_KEY, {
  auth: NO_SESSION,
  global: {headers: authorization ? {Authorization: authorization}:{}},
});