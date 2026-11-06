import type { SupabaseClient } from  '@supabase/supabase-js';

export type Bindings = {
  SUPABAE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ALLOWED_ORIGIN?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  // Chỉ có giá trị sau middleware requireAmin.
  Variables:{ adminUserId: string; requestSupabase: SupabaseClient };
};