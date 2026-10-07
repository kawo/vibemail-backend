import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { requireEnv } from '../config/env';
import type { Database } from '../types';

let cached: SupabaseClient<Database> | null = null;

/** The single server-only Supabase client (service role, bypasses RLS; CONTRACT.md §3.1, §5.3). */
export function getServiceClient(env: NodeJS.ProcessEnv = process.env): SupabaseClient<Database> {
  if (!cached) {
    cached = createClient<Database>(requireEnv('SUPABASE_URL', env), requireEnv('SUPABASE_SERVICE_ROLE_KEY', env), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}
