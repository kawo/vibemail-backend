import jwt from 'jsonwebtoken';
import { MissingEnvError } from '../../src/config/env';
import type { AppDeps } from '../../src/http/deps';
import { createHandlers } from '../../src/http/handlers';
import { STATE_COOKIE, issueState } from '../../src/middleware/oauthState';
import { toMessageRow } from '../../src/db/messages';
import { createFakeProviderFactory, fakeMessage } from '../fakes/fakeProvider';
import { FakeSessions, SessionError } from '../fakes/fakeSessions';
import { MemoryMessages, MemoryUsers } from '../fakes/memoryRepos';

const SECRET = 'test-jwt-secret-at-least-32-characters!!';
const SUPABASE = 'https://proj.supabase.co';
const FRONTEND = 'https://app.vibemail.test';
const USER = 'user-1';
const EMAIL = 'me@example.com';
const now = new Date('2026-10-06T10:00:00.000Z');

function bearer(overrides: Record<string, unknown> = {}, options: jwt.SignOptions = {}, secret = SECRET): string {
  return jwt.sign({ sub: USER, email: EMAIL, ...overrides }, secret, {
    algorithm: 'HS256',
    audience: 'authenticated',
    issuer: `${SUPABASE}/auth/v1`,
    expiresIn: '1h',
    ...options,
  });
}

function setup(connected = true) {
  const { factory, box } = createFakeProviderFactory(undefined, {
    grant: {
      accountId: 'google-1',
      email: EMAIL,
      name: 'Me Example',
      idToken: 'id-token-1',
      scopes: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send'],
      credentials: { refreshToken: 'r', accessToken: 'a', accessTokenExpiresAt: new Date(Date.now() + 3600_000) },
    },
  });
  const users = new MemoryUsers();
  if (connected) {
    users.rows.set(USER, {
      googleId: 'google-1',
      userId: USER,
      email: EMAIL,
      scopes: [],
      credentials: { refreshToken: 'r', accessToken: null, accessTokenExpiresAt: null },
      historyId: '1',
      lastSyncedAt: now,
    });
  }
  const messages = new MemoryMessages();
  const sessions = new FakeSessions({ userId: USER, email: EMAIL });
  const pending: Array<Promise<unknown>> = [];
  const deps: AppDeps = {
    factory,
    users,
    messages,
    sessions,
    jwtSecret: SECRET,
    supabaseUrl: SUPABASE,
    frontendUrl: FRONTEND,
    pubsubVerificationToken: 't'.repeat(32),
    cronSecret: 'c'.repeat(32),
    waitUntil: (p) => {
      pending.push(p);
    },
    now: () => now,
    log: jest.fn(),
  };
  const store = (id: string, minute: number, labels = ['INBOX', 'UNREAD']) =>
    messages.upsertMessages(USER, [
      toMessageRow(USER, fakeMessage({ id, labels, receivedAt: new Date(Date.UTC(2026, 9, 1, 0, minute)) }), now),
    ]);
  return { h: createHandlers(() => deps), deps, box, users, messages, sessions, store, pending };
}

const get = (path: string, token?: string, cookie?: string) =>
  new Request(`https://api.vibemail.test${path}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
const post = (path: string, body: unknown, token?: string) =>
  new Request(`https://api.vibemail.test${path}`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

async function envelope(response: Response) {
  return (await response.json()) as { error: { code: string; message: string; retryable: boolean; details?: unknown } };
}

describe('JWT middleware on bearer-protected routes (CONTRACT.md §3.1)', () => {
  it.each([
    ['no bearer', undefined],
    ['wrong secret', bearer({}, {}, 'another-secret-also-32-characters-long!!')],
    ['wrong audience', bearer({}, { audience: 'anon' })],
    ['wrong issuer', bearer({}, { issuer: 'https://evil.example/auth/v1' })],
    ['expired', bearer({}, { expiresIn: -10 })],
    ['alg none', `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: USER, email: EMAIL, aud: 'authenticated', iss: `${SUPABASE}/auth/v1` })).toString('base64url')}.`],
  ])('rejects %s with the 401 envelope and CORS headers', async (_name, token) => {
    const { h, box } = setup();
    box.forbidCalls = true;
    const response = await h.listMessages(get('/api/v1/messages', token));
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe(FRONTEND);
    expect(response.headers.get('set-cookie')).toBeNull();
    await expect(envelope(response)).resolves.toEqual({
      error: { code: 'UNAUTHENTICATED', message: expect.any(String), retryable: false },
    });
  });

  it('applies to send and read too', async () => {
    const { h } = setup();
    const responses = await Promise.all([
      h.sendMessage(post('/api/v1/messages/send', { to: 'a@x.io', subject: 's', body: 'b' })),
      h.markRead(post('/api/v1/messages/m1/read', {})),
    ]);
    expect(responses.map((r) => r.status)).toEqual([401, 401]);
  });
});

const OAUTH_ENV = {
  JWT_SECRET: SECRET,
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_REDIRECT_URI: 'https://api.vibemail.test/api/v1/auth/google/callback',
};

describe('GET /api/v1/auth/google (§4.1a)', () => {
  let saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    Object.assign(process.env, OAUTH_ENV);
  });
  afterEach(() => {
    process.env = saved;
  });

  it('needs no bearer: sets the state cookie and 302s to Google, and the callback signs the user in', async () => {
    const { h, users } = setup(false);
    const response = await h.startSignIn(get('/api/v1/auth/google'));
    expect(response.status).toBe(302);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const target = new URL(response.headers.get('location') ?? '');
    expect(target.origin).toBe('https://accounts.google.com');
    expect(target.searchParams.get('client_id')).toBe(OAUTH_ENV.GOOGLE_CLIENT_ID);
    expect(target.searchParams.get('redirect_uri')).toBe(OAUTH_ENV.GOOGLE_REDIRECT_URI);
    expect(target.searchParams.get('access_type')).toBe('offline');

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(new RegExp(`^${STATE_COOKIE}=[\\w-]+; Path=/api/v1/auth/google; Max-Age=600; HttpOnly; Secure; SameSite=Lax$`));
    const cookie = setCookie.split(';')[0] ?? '';

    const state = target.searchParams.get('state') ?? '';
    const callback = await h.oauthCallback(
      get(`/api/v1/auth/google/callback?${new URLSearchParams({ code: 'c', state }).toString()}`, undefined, cookie),
    );
    const landing = new URL(callback.headers.get('location') ?? '');
    expect(landing.searchParams.get('status')).toBe('signed_in');
    expect(users.rows.get(USER)?.googleId).toBe('google-1');
  });

  it.each(['JWT_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'])(
    'answers 500 CONFIG_ERROR when initiateOAuth is missing %s',
    async (variable) => {
      delete process.env[variable];
      const { h } = setup(false);
      const response = await h.startSignIn(get('/api/v1/auth/google'));
      expect(response.status).toBe(500);
      expect(response.headers.get('set-cookie')).toBeNull();
      await expect(envelope(response)).resolves.toEqual({
        error: { code: 'CONFIG_ERROR', message: 'server is not configured', retryable: false },
      });
    },
  );

  it('answers 500 CONFIG_ERROR when the app configuration is missing', async () => {
    const h = createHandlers(() => {
      throw new MissingEnvError('SUPABASE_URL');
    });
    const response = await h.startSignIn(get('/api/v1/auth/google'));
    expect(response.status).toBe(500);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'CONFIG_ERROR' } });
  });
});

describe('non-GET methods on the OAuth endpoints (§4.1)', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])('%s → 405 METHOD_NOT_ALLOWED with Allow: GET', async (method) => {
    const { h, box } = setup(false);
    box.forbidCalls = true;
    const request = (path: string) => new Request(`https://api.vibemail.test${path}`, { method });
    for (const response of [
      await h.oauthMethodNotAllowed(request('/api/v1/auth/google')),
      await h.startSignIn(request('/api/v1/auth/google')),
      await h.oauthCallback(request('/api/v1/auth/google/callback')),
    ]) {
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET');
      await expect(envelope(response)).resolves.toEqual({
        error: { code: 'METHOD_NOT_ALLOWED', message: 'only GET is allowed', retryable: false },
      });
    }
  });
});

describe('GET /api/v1/auth/google/callback (§4.1b)', () => {
  it('answers 500 CONFIG_ERROR, not a redirect, when the configuration is missing', async () => {
    const h = createHandlers(() => {
      throw new MissingEnvError('FRONTEND_URL');
    });
    const response = await h.oauthCallback(get('/api/v1/auth/google/callback?code=c&state=s'));
    expect(response.status).toBe(500);
    expect(response.headers.get('location')).toBeNull();
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'CONFIG_ERROR' } });
  });

  /** A state plus the matching browser cookie, as `GET /api/v1/auth/google` would have set. */
  const started = (at: Date = now) => {
    const { state, nonce } = issueState(SECRET, at);
    return { state, cookie: `${STATE_COOKIE}=${nonce}` };
  };
  const callback = (params: Record<string, string>, cookie?: string) =>
    get(`/api/v1/auth/google/callback?${new URLSearchParams(params).toString()}`, undefined, cookie);
  const location = (response: Response) => new URL(response.headers.get('location') ?? '');

  it('signs in, stores the Gmail account, and hands the session over in the fragment only', async () => {
    const { h, users, sessions } = setup(false);
    const { state, cookie } = started();
    const response = await h.oauthCallback(callback({ code: 'c', state }, cookie));
    expect(response.status).toBe(302);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('set-cookie')).toContain(`${STATE_COOKIE}=; Path=/api/v1/auth/google; Max-Age=0`);
    const target = location(response);
    expect(`${target.origin}${target.pathname}`).toBe(`${FRONTEND}/auth/callback`);
    expect(Object.fromEntries(target.searchParams)).toEqual({ status: 'signed_in', initialSync: 'completed' });
    expect(Object.fromEntries(new URLSearchParams(target.hash.slice(1)))).toEqual({
      access_token: `sb-access-${USER}`,
      refresh_token: `sb-refresh-${USER}`,
      expires_in: '3600',
      expires_at: '1791000000',
      token_type: 'bearer',
    });
    expect(sessions.calls).toEqual([{ idToken: 'id-token-1', accessToken: 'a' }]);
    expect(users.rows.get(USER)).toMatchObject({ googleId: 'google-1', email: EMAIL, name: 'Me Example' });
  });

  it.each([
    ['tampered state', () => { const s = started(); return [{ code: 'c', state: `${s.state}x` }, s.cookie] as const; }, 'UNAUTHENTICATED', undefined],
    ['expired state', () => { const s = started(new Date(now.getTime() - 11 * 60_000)); return [{ code: 'c', state: s.state }, s.cookie] as const; }, 'UNAUTHENTICATED', undefined],
    ['missing state cookie', () => [{ code: 'c', state: started().state }, undefined] as const, 'UNAUTHENTICATED', undefined],
    ['cookie from another flow', () => [{ code: 'c', state: started().state }, started().cookie] as const, 'UNAUTHENTICATED', undefined],
    ['consent denied', () => { const s = started(); return [{ error: 'access_denied', state: s.state }, s.cookie] as const; }, 'GMAIL_NOT_CONNECTED', 'access_denied'],
    ['missing code', () => { const s = started(); return [{ state: s.state }, s.cookie] as const; }, 'VALIDATION_FAILED', undefined],
  ])('redirects with an error for %s, without a session or writes', async (_name, args, code, reason) => {
    const { h, users, sessions } = setup(false);
    const [params, cookie] = args();
    const response = await h.oauthCallback(callback(params, cookie));
    expect(response.status).toBe(302);
    const target = location(response);
    expect(Object.fromEntries(target.searchParams)).toEqual({ status: 'error', code, ...(reason ? { reason } : {}) });
    expect(target.hash).toBe('');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(sessions.calls).toEqual([]);
    expect(users.rows.size).toBe(0);
  });

  it('redirects with INTERNAL SUPABASE_SIGN_IN_FAILED when Supabase rejects the ID token', async () => {
    const { h, users, sessions } = setup(false);
    sessions.fail = new SessionError('Supabase sign-in failed: Provider not enabled', null);
    const { state, cookie } = started();
    const target = location(await h.oauthCallback(callback({ code: 'c', state }, cookie)));
    expect(Object.fromEntries(target.searchParams)).toEqual({ status: 'error', code: 'INTERNAL', reason: 'SUPABASE_SIGN_IN_FAILED' });
    expect(target.hash).toBe('');
    expect(users.rows.size).toBe(0);
  });
});

describe('GET /api/v1/messages (§4.2)', () => {
  it('pages INBOX rows newest first with an opaque cursor, without calling Gmail', async () => {
    const { h, box, store } = setup();
    await store('m1', 1);
    await store('m2', 2);
    await store('m3', 3);
    await store('sent', 4, ['SENT']);
    box.forbidCalls = true;

    const first = await h.listMessages(get('/api/v1/messages?limit=2', bearer()));
    expect(first.status).toBe(200);
    expect(first.headers.get('access-control-allow-origin')).toBe(FRONTEND);
    const page1 = (await first.json()) as { messages: Array<{ gmailId: string; isRead: boolean }>; nextCursor: string | null; lastSyncedAt: string };
    expect(page1.messages.map((m) => m.gmailId)).toEqual(['m3', 'm2']);
    expect(page1.lastSyncedAt).toBe(now.toISOString());
    expect(page1.nextCursor).not.toBeNull();

    const second = await h.listMessages(get(`/api/v1/messages?limit=2&cursor=${page1.nextCursor ?? ''}`, bearer()));
    const page2 = (await second.json()) as { messages: Array<{ gmailId: string }>; nextCursor: string | null };
    expect(page2.messages.map((m) => m.gmailId)).toEqual(['m1']);
    expect(page2.nextCursor).toBeNull();
    expect(box.calls).toEqual([]);
  });

  it.each([['limit=0'], ['limit=101'], ['limit=abc'], ['cursor=%%%']])('rejects %s with 400', async (query) => {
    const { h } = setup();
    const response = await h.listMessages(get(`/api/v1/messages?${query}`, bearer()));
    expect(response.status).toBe(400);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'VALIDATION_FAILED', retryable: false } });
  });

  it('reports GMAIL_NOT_CONNECTED with 409', async () => {
    const { h } = setup(false);
    const response = await h.listMessages(get('/api/v1/messages', bearer()));
    expect(response.status).toBe(409);
  });
});

describe('POST /api/v1/messages/send (§4.3)', () => {
  it('returns 201 with the stored message as a MessageDTO', async () => {
    const { h } = setup();
    const response = await h.sendMessage(post('/api/v1/messages/send', { to: 'you@example.com', subject: 'Hi', body: 'Hello' }, bearer()));
    expect(response.status).toBe(201);
    const { message } = (await response.json()) as { message: Record<string, unknown> };
    expect(message).toMatchObject({ gmailId: 'sent-1', labelIds: ['SENT'], fromAddress: EMAIL, toAddress: ['you@example.com'], bodyPlain: 'Hello' });
    expect(message).not.toHaveProperty('user_id');
  });

  it('rejects a non-JSON body with 400', async () => {
    const { h } = setup();
    const response = await h.sendMessage(post('/api/v1/messages/send', '{oops', bearer()));
    expect(response.status).toBe(400);
  });
});

describe('POST /api/v1/messages/{id}/read (§4.4)', () => {
  it('marks read idempotently and returns the updated message', async () => {
    const { h, box, store } = setup();
    await store('m1', 1);
    box.messages.set('m1', fakeMessage({ id: 'm1', labels: ['INBOX', 'UNREAD'] }));
    const one = await h.markRead(post('/api/v1/messages/m1/read', {}, bearer()));
    const two = await h.markRead(post('/api/v1/messages/m1/read', {}, bearer()));
    expect([one.status, two.status]).toEqual([200, 200]);
    const { message } = (await two.json()) as { message: { isRead: boolean; labelIds: string[] } };
    expect(message).toMatchObject({ isRead: true, labelIds: ['INBOX'] });
  });

  it('returns 404 for a message the user does not have, with no Gmail call', async () => {
    const { h, box, messages } = setup();
    await messages.upsertMessages('user-2', [toMessageRow('user-2', fakeMessage({ id: 'theirs' }), now)]);
    box.forbidCalls = true;
    const response = await h.markRead(post('/api/v1/messages/theirs/read', {}, bearer()));
    expect(response.status).toBe(404);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'MESSAGE_NOT_FOUND' } });
  });

  it('removes a stored message Gmail no longer has, then returns 404', async () => {
    const { h, store, messages } = setup();
    await store('gone', 1);
    const response = await h.markRead(post('/api/v1/messages/gone/read', {}, bearer()));
    expect(response.status).toBe(404);
    expect(messages.deleted).toEqual([[USER, 'gone']]);
  });
});

describe('webhook, preflight and configuration', () => {
  it('routes the webhook with its own token check and no CORS', async () => {
    const { h } = setup();
    const response = await h.gmailWebhook(post('/api/webhook/gmail?token=wrong', { message: { data: 'x' } }));
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('runs the cron job with the CRON_SECRET bearer, without CORS', async () => {
    const { h } = setup();
    const ok = await h.renewWatch(new Request('https://api.vibemail.test/api/cron/renew-watch', { headers: { Authorization: `Bearer ${'c'.repeat(32)}` } }));
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ renewed: 1, revoked: 0, failed: 0 });
    expect(ok.headers.get('access-control-allow-origin')).toBeNull();
    const denied = await h.renewWatch(new Request('https://api.vibemail.test/api/cron/renew-watch'));
    expect(denied.status).toBe(401);
    await expect(envelope(denied)).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('answers CORS preflight with 204', async () => {
    const { h } = setup();
    const response = await h.options(new Request('https://api.vibemail.test/api/v1/messages', { method: 'OPTIONS' }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect(response.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');
  });

  it('turns missing configuration into a 500 INTERNAL envelope', async () => {
    const h = createHandlers(() => {
      throw new MissingEnvError('JWT_SECRET');
    });
    const response = await h.listMessages(get('/api/v1/messages', bearer()));
    expect(response.status).toBe(500);
    await expect(envelope(response)).resolves.toEqual({
      error: { code: 'INTERNAL', message: 'server is not configured', retryable: false },
    });
  });
});
