import { waitUntil } from '@vercel/functions';
import { requireEnv } from '../config/env';
import { type MessagesRepository, type UsersRepository, createDb, getServiceClient, keyFromEnv } from '../db';
import { gmailAuthConfigFromEnv } from '../providers/gmail/auth';
import { createGmailProviderFactory } from '../providers/gmail/provider';
import type { MailProviderFactory } from '../providers/provider';
import { type SessionIssuer, createSupabaseSessionIssuer } from '../services/supabaseSession';

/** Everything a handler needs. Built once per warm function instance, from env (CONTRACT.md §3.6). */
export interface AppDeps {
  factory: MailProviderFactory;
  users: UsersRepository;
  messages: MessagesRepository;
  /** Supabase Auth sign-in with a Google ID token (CONTRACT.md §4.1b). */
  sessions: SessionIssuer;
  jwtSecret: string;
  supabaseUrl: string;
  frontendUrl: string;
  pubsubVerificationToken: string | undefined;
  /** `CRON_SECRET`; the cron handler fails closed when it is missing (CONTRACT.md §4.6). */
  cronSecret: string | undefined;
  waitUntil: (promise: Promise<unknown>) => void;
  now: () => Date;
  log: (message: string, error?: unknown) => void;
}

let cached: AppDeps | null = null;

/** Throws `MissingEnvError` (→ 500 INTERNAL) when a required variable is missing. */
export function depsFromEnv(env: NodeJS.ProcessEnv = process.env): AppDeps {
  if (cached) {
    return cached;
  }
  const db = createDb(getServiceClient(env), keyFromEnv(env));
  cached = {
    factory: createGmailProviderFactory(gmailAuthConfigFromEnv(env)),
    users: db.users,
    messages: db.messages,
    sessions: createSupabaseSessionIssuer(requireEnv('SUPABASE_URL', env), requireEnv('SUPABASE_SERVICE_ROLE_KEY', env)),
    jwtSecret: requireEnv('JWT_SECRET', env),
    supabaseUrl: requireEnv('SUPABASE_URL', env),
    frontendUrl: requireEnv('FRONTEND_URL', env),
    // Optional here: the webhook fails closed itself when it is missing (CONTRACT.md §4.5).
    pubsubVerificationToken: env.GOOGLE_PUBSUB_VERIFICATION_TOKEN,
    cronSecret: env.CRON_SECRET,
    waitUntil: (promise) => {
      waitUntil(promise);
    },
    now: () => new Date(),
    log: (message, error) => {
      console.error(message, error instanceof Error ? error.message : (error ?? ''));
    },
  };
  return cached;
}
