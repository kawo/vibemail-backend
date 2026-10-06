import { waitUntil } from '@vercel/functions';
import { requireEnv } from '../config/env';
import { getServiceClient } from '../db/client';
import { keyFromEnv } from '../db/crypto';
import { type MessagesRepository, createMessagesRepository } from '../db/messages';
import { type UsersRepository, createUsersRepository } from '../db/users';
import { gmailAuthConfigFromEnv } from '../providers/gmail/auth';
import { createGmailProviderFactory } from '../providers/gmail/provider';
import type { MailProviderFactory } from '../providers/provider';

/** Everything a handler needs. Built once per warm function instance, from env (CONTRACT.md §3.6). */
export interface AppDeps {
  factory: MailProviderFactory;
  users: UsersRepository;
  messages: MessagesRepository;
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
  const db = getServiceClient(env);
  cached = {
    factory: createGmailProviderFactory(gmailAuthConfigFromEnv(env)),
    users: createUsersRepository(db, keyFromEnv(env)),
    messages: createMessagesRepository(db),
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
