/**
 * Shared setup for integration tests (BUILD_SEQUENCE.md unit 8).
 *
 * - Supabase is LIVE: the project in `.env` (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY), a dev/test
 *   project. Nothing in src/db is mocked. Missing configuration fails the run; it never skips.
 * - Gmail is mocked with the in-memory fake provider (tests/fakes/fakeProvider.ts).
 * - Users are real Supabase Auth users with `@vibemail.test` emails, deleted after each file;
 *   their `users` / `messages` rows go with them (FK on delete cascade).
 * - Bearer tokens are signed with a test secret: the server verifies JWTs locally (CONTRACT.md §3.1),
 *   so it only needs to agree with itself.
 */
import { randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { type MessageRow, createMessagesRepository } from '../../src/db/messages';
import { createUsersRepository } from '../../src/db/users';
import type { AppDeps } from '../../src/http/deps';
import { createHandlers } from '../../src/http/handlers';
import { GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE } from '../../src/providers/gmail/auth';
import type { ProviderMessage, VerifiedGrant } from '../../src/providers/provider';
import { toMessageRow } from '../../src/sync';
import { type FakeMailbox, createFakeMailbox, createFakeProviderFactory, cursor } from '../fakes/fakeProvider';

export const TEST_JWT_SECRET = 'integration-test-jwt-secret-not-for-production-use';
export const FRONTEND_URL = 'https://app.vibemail.test';
export const PUBSUB_TOKEN = 'p'.repeat(40);
export const CRON_SECRET = 'c'.repeat(40);
export const ENCRYPTION_KEY = randomBytes(32);

/** Loads `.env` into process.env (without overriding variables already set). */
function loadDotEnv(): void {
  const file = path.resolve(__dirname, '../../.env');
  if (!fs.existsSync(file)) {
    return;
  }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] && process.env[match[1]] === undefined) {
      process.env[match[1]] = (match[2] ?? '').trim();
    }
  }
}

export function liveConfig(): { url: string; serviceKey: string } {
  loadDotEnv();
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'Integration tests need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (a dev/test project) in .env or the environment.',
    );
  }
  return { url, serviceKey };
}

let adminClient: SupabaseClient | null = null;

/** Service-role client on the live project. */
export function admin(): SupabaseClient {
  if (!adminClient) {
    const { url, serviceKey } = liveConfig();
    adminClient = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return adminClient;
}

export interface TestUser {
  userId: string;
  email: string;
  googleId: string;
}

const created: string[] = [];

/** Creates a real Supabase Auth user. Call `deleteTestUsers()` in `afterAll`. */
export async function createTestUser(): Promise<TestUser> {
  const email = `it-${randomUUID()}@vibemail.test`;
  const { data, error } = await admin().auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) {
    throw new Error(`could not create test user: ${error?.message ?? 'no user returned'}`);
  }
  created.push(data.user.id);
  return { userId: data.user.id, email, googleId: `google-${randomUUID()}` };
}

/** Deletes every user created in this file; their rows cascade. */
export async function deleteTestUsers(): Promise<void> {
  const ids = created.splice(0);
  await Promise.all(ids.map((id) => admin().auth.admin.deleteUser(id)));
}

/** A Supabase access token as the frontend would send it (CONTRACT.md §3.1). */
export function bearerFor(user: TestUser, options: jwt.SignOptions = {}): string {
  return jwt.sign({ sub: user.userId, email: user.email, role: 'authenticated' }, TEST_JWT_SECRET, {
    algorithm: 'HS256',
    audience: 'authenticated',
    issuer: `${liveConfig().url.replace(/\/+$/, '')}/auth/v1`,
    expiresIn: '1h',
    ...options,
  });
}

export function grantFor(user: TestUser, overrides: Partial<VerifiedGrant> = {}): VerifiedGrant {
  return {
    accountId: user.googleId,
    email: user.email,
    scopes: [GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE],
    credentials: {
      refreshToken: `refresh-${user.userId}`,
      accessToken: `access-${user.userId}`,
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    },
    ...overrides,
  };
}

export interface App {
  handlers: ReturnType<typeof createHandlers>;
  deps: AppDeps;
  box: FakeMailbox;
  /** Background work handed to `waitUntil` (webhook). */
  pending: Array<Promise<unknown>>;
}

/**
 * The real handlers on the live database, with Gmail faked. `grant` is what the fake returns
 * for an OAuth code exchange. `db` defaults to the service-role client.
 */
export function buildApp(options: { grant?: VerifiedGrant; db?: SupabaseClient; box?: FakeMailbox } = {}): App {
  const db = options.db ?? admin();
  const box = options.box ?? createFakeMailbox();
  const { factory } = createFakeProviderFactory(box, options.grant ? { grant: options.grant } : {});
  const pending: Array<Promise<unknown>> = [];
  const deps: AppDeps = {
    factory,
    users: createUsersRepository(db, ENCRYPTION_KEY),
    messages: createMessagesRepository(db),
    jwtSecret: TEST_JWT_SECRET,
    supabaseUrl: liveConfig().url,
    frontendUrl: FRONTEND_URL,
    pubsubVerificationToken: PUBSUB_TOKEN,
    cronSecret: CRON_SECRET,
    waitUntil: (promise) => {
      pending.push(promise);
    },
    now: () => new Date(),
    log: () => undefined,
  };
  return { handlers: createHandlers(() => deps), deps, box, pending };
}

/** The same app on a client with an invalid key: every DB call fails for real, giving `INTERNAL`. */
export function buildBrokenDbApp(options: { grant?: VerifiedGrant; box?: FakeMailbox } = {}): App {
  const { url } = liveConfig();
  const broken = createClient(url, 'invalid-service-role-key', { auth: { persistSession: false } });
  return buildApp({ ...options, db: broken });
}

/** Connects a user through the real repository, as the OAuth callback would. */
export async function seedConnectedUser(
  app: App,
  user: TestUser,
  state: { historyId?: string; watch?: Date } = {},
): Promise<void> {
  const grant = grantFor(user);
  const outcome = await app.deps.users.upsertConnectedUser({
    googleId: user.googleId,
    userId: user.userId,
    email: user.email,
    scopes: grant.scopes,
    credentials: grant.credentials,
  });
  if (outcome !== 'ok') {
    throw new Error(`seed failed: ${outcome}`);
  }
  if (state.historyId) {
    await app.deps.users.recordSync(user.userId, state.historyId, new Date());
  }
  if (state.watch) {
    await app.deps.users.updateWatch(user.userId, state.watch);
  }
}

export async function seedMessages(app: App, user: TestUser, messages: ProviderMessage[]): Promise<MessageRow[]> {
  const rows = messages.map((m) => toMessageRow(user.userId, m, new Date()));
  await app.deps.messages.upsertMessages(user.userId, rows);
  return rows;
}

/** Reads a `users` row straight from the database (bypassing the repository). */
export async function rawUserRow(userId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await admin().from('users').select('*').eq('user_id', userId).maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return data as Record<string, unknown> | null;
}

export async function rawMessageRows(userId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await admin().from('messages').select('*').eq('user_id', userId);
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []) as Array<Record<string, unknown>>;
}

export async function envelope(response: Response): Promise<{
  error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
}> {
  return (await response.json()) as {
    error: { code: string; message: string; retryable: boolean; details?: Record<string, unknown> };
  };
}

export const req = {
  get: (p: string, token?: string): Request =>
    new Request(`https://api.vibemail.test${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }),
  post: (p: string, body: unknown, token?: string, headers: Record<string, string> = {}): Request =>
    new Request(`https://api.vibemail.test${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
};

export { cursor };
