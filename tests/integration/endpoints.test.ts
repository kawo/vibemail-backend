/**
 * Endpoint integration tests: every HTTP status and every `error.code` named in CONTRACT.md §4,
 * through the real handlers and the LIVE Supabase project. Gmail is faked.
 */
import { MissingEnvError } from '../../src/config/env';
import { createHandlers } from '../../src/http/handlers';
import { ProviderError } from '../../src/providers/provider';
import { fakeMessage } from '../fakes/fakeProvider';
import {
  CRON_SECRET,
  FRONTEND_URL,
  PUBSUB_TOKEN,
  type TestUser,
  bearerFor,
  buildApp,
  buildBrokenDbApp,
  createTestUser,
  deleteTestUsers,
  envelope,
  grantFor,
  rawMessageRows,
  rawUserRow,
  req,
  seedConnectedUser,
  seedMessages,
} from './support';

jest.setTimeout(60_000);

afterAll(deleteTestUsers);

/** Runs the start endpoint and returns the signed state it issued. */
async function startState(user: TestUser, app = buildApp()): Promise<string> {
  const response = await app.handlers.startConnect(req.get('/api/v1/auth/google/start', bearerFor(user)));
  const { authorizationUrl } = (await response.json()) as { authorizationUrl: string };
  return new URL(authorizationUrl).searchParams.get('state') ?? '';
}

function redirectQuery(response: Response): Record<string, string> {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location') ?? '');
  expect(`${location.origin}${location.pathname}`).toBe(`${FRONTEND_URL}/settings/gmail`);
  return Object.fromEntries(location.searchParams);
}

const callbackUrl = (params: Record<string, string>) =>
  `/api/v1/auth/google/callback?${new URLSearchParams(params).toString()}`;

describe('§4.1a GET /api/v1/auth/google/start', () => {
  it('200: consent URL with a signed state and offline access', async () => {
    const user = await createTestUser();
    const response = await buildApp().handlers.startConnect(req.get('/api/v1/auth/google/start', bearerFor(user)));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorizationUrl: string; expiresAt: string };
    const url = new URL(body.authorizationUrl);
    expect(url.searchParams.get('state')?.split('.')).toHaveLength(2);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('401 UNAUTHENTICATED: no bearer', async () => {
    const response = await buildApp().handlers.startConnect(req.get('/api/v1/auth/google/start'));
    expect(response.status).toBe(401);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED', retryable: false } });
  });

  it('500 INTERNAL: server not configured', async () => {
    const handlers = createHandlers(() => {
      throw new MissingEnvError('JWT_SECRET');
    });
    const user = await createTestUser();
    const response = await handlers.startConnect(req.get('/api/v1/auth/google/start', bearerFor(user)));
    expect(response.status).toBe(500);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'INTERNAL' } });
  });
});

describe('§4.1b GET /api/v1/auth/google/callback', () => {
  it('302 status=connected: stores the account keyed by google_id, tokens encrypted', async () => {
    const user = await createTestUser();
    const app = buildApp({ grant: grantFor(user) });
    const state = await startState(user, app);
    const query = redirectQuery(await app.handlers.oauthCallback(req.get(callbackUrl({ code: 'c', state }))));
    expect(query).toEqual({ status: 'connected', initialSync: 'completed' });

    const row = await rawUserRow(user.userId);
    expect(row).toMatchObject({ google_id: user.googleId, email: user.email });
    expect(String(row?.refresh_token)).toMatch(/^v1:/);
    expect(String(row?.refresh_token)).not.toContain(`refresh-${user.userId}`);
    expect(row?.watch_expiration).not.toBeNull();
  });

  it('302 UNAUTHENTICATED: tampered state, nothing written', async () => {
    const user = await createTestUser();
    const app = buildApp({ grant: grantFor(user) });
    const state = `${await startState(user, app)}x`;
    expect(redirectQuery(await app.handlers.oauthCallback(req.get(callbackUrl({ code: 'c', state }))))).toEqual({
      status: 'error',
      code: 'UNAUTHENTICATED',
    });
    await expect(rawUserRow(user.userId)).resolves.toBeNull();
  });

  it('302 VALIDATION_FAILED: missing code', async () => {
    const user = await createTestUser();
    const app = buildApp({ grant: grantFor(user) });
    const state = await startState(user, app);
    expect(redirectQuery(await app.handlers.oauthCallback(req.get(callbackUrl({ state }))))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('302 VALIDATION_FAILED EMAIL_MISMATCH: Google account differs from the user', async () => {
    const user = await createTestUser();
    const app = buildApp({ grant: grantFor(user, { email: 'someone-else@vibemail.test' }) });
    const state = await startState(user, app);
    expect(redirectQuery(await app.handlers.oauthCallback(req.get(callbackUrl({ code: 'c', state }))))).toEqual({
      status: 'error',
      code: 'VALIDATION_FAILED',
      reason: 'EMAIL_MISMATCH',
    });
    await expect(rawUserRow(user.userId)).resolves.toBeNull();
  });

  it('302 VALIDATION_FAILED GOOGLE_ACCOUNT_LINKED_ELSEWHERE: the Google account belongs to another user', async () => {
    const owner = await createTestUser();
    await seedConnectedUser(buildApp(), owner);
    const intruder = await createTestUser();
    const app = buildApp({ grant: grantFor(intruder, { accountId: owner.googleId }) });
    const state = await startState(intruder, app);
    expect(redirectQuery(await app.handlers.oauthCallback(req.get(callbackUrl({ code: 'c', state }))))).toMatchObject({
      code: 'VALIDATION_FAILED',
      reason: 'GOOGLE_ACCOUNT_LINKED_ELSEWHERE',
    });
  });

  it('302 GMAIL_NOT_CONNECTED: consent denied, and missing Gmail scope', async () => {
    const user = await createTestUser();
    const denied = buildApp({ grant: grantFor(user) });
    expect(
      redirectQuery(
        await denied.handlers.oauthCallback(req.get(callbackUrl({ error: 'access_denied', state: await startState(user, denied) }))),
      ),
    ).toEqual({ status: 'error', code: 'GMAIL_NOT_CONNECTED', reason: 'access_denied' });

    const noScope = buildApp({ grant: grantFor(user, { scopes: [] }) });
    expect(
      redirectQuery(await noScope.handlers.oauthCallback(req.get(callbackUrl({ code: 'c', state: await startState(user, noScope) })))),
    ).toMatchObject({ code: 'GMAIL_NOT_CONNECTED', reason: 'missing_gmail_scope' });
    await expect(rawUserRow(user.userId)).resolves.toBeNull();
  });

  it.each([
    ['GMAIL_TOKEN_REVOKED', new ProviderError('revoked', 'invalid_grant')],
    ['GMAIL_RATE_LIMITED', new ProviderError('rate_limited', 'slow down', { retryAfterSeconds: 10 })],
    ['GMAIL_UPSTREAM_ERROR', new ProviderError('upstream', 'google 503')],
  ])('302 %s: code exchange fails', async (code, failure) => {
    const user = await createTestUser();
    const app = buildApp({ grant: grantFor(user) });
    jest.spyOn(app.deps.factory, 'exchangeAuthorizationCode').mockRejectedValueOnce(failure);
    const state = await startState(user, app);
    expect(redirectQuery(await app.handlers.oauthCallback(req.get(callbackUrl({ code: 'c', state }))))).toMatchObject({
      status: 'error',
      code,
    });
    await expect(rawUserRow(user.userId)).resolves.toBeNull();
  });

  it('302 INTERNAL: database failure', async () => {
    const user = await createTestUser();
    const app = buildBrokenDbApp({ grant: grantFor(user) });
    const state = await startState(user, app);
    expect(redirectQuery(await app.handlers.oauthCallback(req.get(callbackUrl({ code: 'c', state }))))).toMatchObject({
      code: 'INTERNAL',
    });
  });
});

describe('§4.2 GET /api/v1/messages', () => {
  it('200: INBOX only, newest first, cursor paging, DB only', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user, { historyId: '10' });
    await seedMessages(app, user, [
      fakeMessage({ id: 'aaa1', receivedAt: new Date('2026-10-01T10:00:00Z') }),
      fakeMessage({ id: 'aaa2', receivedAt: new Date('2026-10-02T10:00:00Z') }),
      fakeMessage({ id: 'aaa3', receivedAt: new Date('2026-10-03T10:00:00Z') }),
      fakeMessage({ id: 'sent1', labels: ['SENT'], receivedAt: new Date('2026-10-04T10:00:00Z') }),
    ]);
    app.box.forbidCalls = true;

    const first = await app.handlers.listMessages(req.get('/api/v1/messages?limit=2', bearerFor(user)));
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as { messages: Array<{ gmailId: string }>; nextCursor: string; lastSyncedAt: string };
    expect(page1.messages.map((m) => m.gmailId)).toEqual(['aaa3', 'aaa2']);
    expect(page1.lastSyncedAt).not.toBeNull();

    const second = await app.handlers.listMessages(req.get(`/api/v1/messages?limit=2&cursor=${page1.nextCursor}`, bearerFor(user)));
    const page2 = (await second.json()) as { messages: Array<{ gmailId: string }>; nextCursor: string | null };
    expect(page2.messages.map((m) => m.gmailId)).toEqual(['aaa1']);
    expect(page2.nextCursor).toBeNull();
    expect(app.box.calls).toEqual([]);
  });

  it("200: never returns another user's messages", async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, a);
    await seedConnectedUser(app, b);
    await seedMessages(app, b, [fakeMessage({ id: 'bmsg1' })]);
    const response = await app.handlers.listMessages(req.get('/api/v1/messages', bearerFor(a)));
    await expect(response.json()).resolves.toMatchObject({ messages: [] });
  });

  it('401 UNAUTHENTICATED: no bearer, expired bearer', async () => {
    const user = await createTestUser();
    const app = buildApp();
    for (const token of [undefined, bearerFor(user, { expiresIn: -60 })]) {
      const response = await app.handlers.listMessages(req.get('/api/v1/messages', token));
      expect(response.status).toBe(401);
      await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    }
  });

  it('409 GMAIL_NOT_CONNECTED: no users row', async () => {
    const user = await createTestUser();
    const response = await buildApp().handlers.listMessages(req.get('/api/v1/messages', bearerFor(user)));
    expect(response.status).toBe(409);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'GMAIL_NOT_CONNECTED' } });
  });

  it('400 VALIDATION_FAILED: bad limit, bad cursor', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user);
    for (const query of ['limit=0', 'limit=101', 'cursor=not-a-cursor']) {
      const response = await app.handlers.listMessages(req.get(`/api/v1/messages?${query}`, bearerFor(user)));
      expect(response.status).toBe(400);
      await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
  });

  it('500 INTERNAL: database failure', async () => {
    const user = await createTestUser();
    const response = await buildBrokenDbApp().handlers.listMessages(req.get('/api/v1/messages', bearerFor(user)));
    expect(response.status).toBe(500);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'INTERNAL', retryable: false } });
  });
});

describe('§4.3 POST /api/v1/messages/send', () => {
  const body = { to: 'friend@vibemail.test', subject: 'Hi', body: 'Hello' };

  it('201: sends, fetches back, stores and returns the message', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user);
    const response = await app.handlers.sendMessage(req.post('/api/v1/messages/send', body, bearerFor(user)));
    expect(response.status).toBe(201);
    const { message } = (await response.json()) as { message: Record<string, unknown> };
    expect(message).toMatchObject({ labelIds: ['SENT'], fromAddress: user.email, toAddress: ['friend@vibemail.test'] });
    const rows = await rawMessageRows(user.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gmail_id: message.gmailId, from_address: user.email, to_address: ['friend@vibemail.test'] });
  });

  it('401 UNAUTHENTICATED: no bearer', async () => {
    const response = await buildApp().handlers.sendMessage(req.post('/api/v1/messages/send', body));
    expect(response.status).toBe(401);
  });

  it('409 GMAIL_NOT_CONNECTED: no users row', async () => {
    const user = await createTestUser();
    const response = await buildApp().handlers.sendMessage(req.post('/api/v1/messages/send', body, bearerFor(user)));
    expect(response.status).toBe(409);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'GMAIL_NOT_CONNECTED' } });
  });

  it('401 GMAIL_TOKEN_REVOKED: invalid_grant clears the stored tokens', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user);
    app.box.failNext.set('sendMessage', new ProviderError('revoked', 'invalid_grant'));
    const response = await app.handlers.sendMessage(req.post('/api/v1/messages/send', body, bearerFor(user)));
    expect(response.status).toBe(401);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'GMAIL_TOKEN_REVOKED' } });
    await expect(rawUserRow(user.userId)).resolves.toMatchObject({ refresh_token: null, access_token: null });
  });

  it('400 VALIDATION_FAILED: invalid fields and non-JSON body', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user);
    const invalid = await app.handlers.sendMessage(
      req.post('/api/v1/messages/send', { to: 'nope', subject: 'a\r\nb' }, bearerFor(user)),
    );
    expect(invalid.status).toBe(400);
    const error = (await envelope(invalid)).error;
    expect(error.code).toBe('VALIDATION_FAILED');
    expect((error.details?.issues as Array<{ field: string }>).map((i) => i.field)).toEqual(['to[0]', 'subject', 'body']);
    const notJson = await app.handlers.sendMessage(req.post('/api/v1/messages/send', '{oops', bearerFor(user)));
    expect(notJson.status).toBe(400);
  });

  it('404 MESSAGE_NOT_FOUND: Gmail does not know the threadId', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user);
    app.box.failNext.set('sendMessage', new ProviderError('not_found', 'thread'));
    const response = await app.handlers.sendMessage(
      req.post('/api/v1/messages/send', { ...body, threadId: 'abc123' }, bearerFor(user)),
    );
    expect(response.status).toBe(404);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'MESSAGE_NOT_FOUND', details: { threadId: 'abc123' } } });
  });

  it('429 GMAIL_RATE_LIMITED: retryable, with Retry-After', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user);
    app.box.failNext.set('sendMessage', new ProviderError('rate_limited', 'slow', { retryAfterSeconds: 30 }));
    const response = await app.handlers.sendMessage(req.post('/api/v1/messages/send', body, bearerFor(user)));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'GMAIL_RATE_LIMITED', retryable: true } });
  });

  it('502 GMAIL_UPSTREAM_ERROR: sent but not fetched back reports sentGmailId', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user);
    app.box.failNext.set('getMessage', new ProviderError('upstream', 'google 500'));
    const response = await app.handlers.sendMessage(req.post('/api/v1/messages/send', body, bearerFor(user)));
    expect(response.status).toBe(502);
    await expect(envelope(response)).resolves.toMatchObject({
      error: { code: 'GMAIL_UPSTREAM_ERROR', retryable: true, details: { sentGmailId: 'sent-1' } },
    });
  });

  it('500 INTERNAL: database failure', async () => {
    const user = await createTestUser();
    const response = await buildBrokenDbApp().handlers.sendMessage(req.post('/api/v1/messages/send', body, bearerFor(user)));
    expect(response.status).toBe(500);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'INTERNAL' } });
  });
});

describe('§4.4 POST /api/v1/messages/{id}/read', () => {
  async function connectedWithUnread(id = 'msg1') {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user);
    const message = fakeMessage({ id, labels: ['INBOX', 'UNREAD'] });
    await seedMessages(app, user, [message]);
    app.box.messages.set(id, message);
    return { user, app };
  }

  it('200: marks read in Gmail and the DB, idempotently', async () => {
    const { user, app } = await connectedWithUnread();
    for (let i = 0; i < 2; i += 1) {
      const response = await app.handlers.markRead(req.post('/api/v1/messages/msg1/read', {}, bearerFor(user)));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ message: { gmailId: 'msg1', isRead: true, labelIds: ['INBOX'] } });
    }
    const [row] = await rawMessageRows(user.userId);
    expect(row).toMatchObject({ is_read: true, label_ids: ['INBOX'] });
  });

  it('401 UNAUTHENTICATED: no bearer', async () => {
    const response = await buildApp().handlers.markRead(req.post('/api/v1/messages/msg1/read', {}));
    expect(response.status).toBe(401);
  });

  it('409 GMAIL_NOT_CONNECTED: stored message but revoked account', async () => {
    const { user, app } = await connectedWithUnread();
    await app.deps.users.clearUserTokens(user.userId);
    const response = await app.handlers.markRead(req.post('/api/v1/messages/msg1/read', {}, bearerFor(user)));
    expect(response.status).toBe(409);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'GMAIL_NOT_CONNECTED' } });
  });

  it('401 GMAIL_TOKEN_REVOKED: invalid_grant', async () => {
    const { user, app } = await connectedWithUnread();
    app.box.failNext.set('markRead', new ProviderError('revoked', 'invalid_grant'));
    const response = await app.handlers.markRead(req.post('/api/v1/messages/msg1/read', {}, bearerFor(user)));
    expect(response.status).toBe(401);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'GMAIL_TOKEN_REVOKED' } });
  });

  it("404 MESSAGE_NOT_FOUND: unknown or another user's message, with no Gmail call", async () => {
    const { user: owner } = await connectedWithUnread('ownersMsg');
    const other = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, other);
    app.box.forbidCalls = true;
    for (const id of ['doesNotExist', 'ownersMsg']) {
      const response = await app.handlers.markRead(req.post(`/api/v1/messages/${id}/read`, {}, bearerFor(other)));
      expect(response.status).toBe(404);
      await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'MESSAGE_NOT_FOUND' } });
    }
    await expect(rawMessageRows(owner.userId)).resolves.toHaveLength(1);
  });

  it('404 MESSAGE_NOT_FOUND: Gmail no longer has it, and the stale row is deleted', async () => {
    const { user, app } = await connectedWithUnread();
    app.box.messages.delete('msg1');
    const response = await app.handlers.markRead(req.post('/api/v1/messages/msg1/read', {}, bearerFor(user)));
    expect(response.status).toBe(404);
    await expect(rawMessageRows(user.userId)).resolves.toEqual([]);
  });

  it.each([
    [429, 'GMAIL_RATE_LIMITED', new ProviderError('rate_limited', 'slow')],
    [502, 'GMAIL_UPSTREAM_ERROR', new ProviderError('upstream', 'google 500')],
  ])('%i %s', async (status, code, failure) => {
    const { user, app } = await connectedWithUnread();
    app.box.failNext.set('markRead', failure);
    const response = await app.handlers.markRead(req.post('/api/v1/messages/msg1/read', {}, bearerFor(user)));
    expect(response.status).toBe(status);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code, retryable: true } });
  });

  it('500 INTERNAL: database failure', async () => {
    const user = await createTestUser();
    const response = await buildBrokenDbApp().handlers.markRead(req.post('/api/v1/messages/msg1/read', {}, bearerFor(user)));
    expect(response.status).toBe(500);
  });
});

describe('§4.5 POST /webhook/gmail', () => {
  const push = (emailAddress: string, historyId: string, token: string | null = PUBSUB_TOKEN) =>
    req.post(`/api/webhook/gmail${token === null ? '' : `?token=${token}`}`, {
      message: { data: Buffer.from(JSON.stringify({ emailAddress, historyId })).toString('base64'), messageId: '1' },
      subscription: 's',
    });

  it('200: acked with an empty body', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user, { historyId: '100' });
    const response = await app.handlers.gmailWebhook(push(user.email, '200'));
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
    await Promise.all(app.pending);
  });

  it('401 UNAUTHENTICATED: wrong or missing token', async () => {
    const app = buildApp();
    for (const token of ['wrong', null]) {
      const response = await app.handlers.gmailWebhook(push('x@vibemail.test', '1', token));
      expect(response.status).toBe(401);
      await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    }
    expect(app.pending).toEqual([]);
  });

  it('400 VALIDATION_FAILED: undecodable message.data', async () => {
    const app = buildApp();
    const response = await app.handlers.gmailWebhook(
      req.post(`/api/webhook/gmail?token=${PUBSUB_TOKEN}`, { message: { data: '%%%' }, subscription: 's' }),
    );
    expect(response.status).toBe(400);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('500 INTERNAL: verification token not configured', async () => {
    const app = buildApp();
    app.deps.pubsubVerificationToken = undefined;
    const response = await app.handlers.gmailWebhook(push('x@vibemail.test', '1'));
    expect(response.status).toBe(500);
    await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'INTERNAL' } });
  });
});

describe('§4.6 GET /api/cron/renew-watch', () => {
  const cron = (secret?: string) =>
    req.get('/api/cron/renew-watch', secret === undefined ? undefined : secret);

  it('200: renews only watches that are missing, expired or within 24 h', async () => {
    const app = buildApp();
    const soon = await createTestUser();
    const later = await createTestUser();
    await seedConnectedUser(app, soon, { watch: new Date(Date.now() + 3600_000) });
    await seedConnectedUser(app, later, { watch: new Date(Date.now() + 5 * 24 * 3600_000) });
    const response = await app.handlers.renewWatch(cron(CRON_SECRET));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { renewed: number; revoked: number; failed: number; durationMs: number };
    expect(body.renewed).toBeGreaterThanOrEqual(1);
    const soonRow = await rawUserRow(soon.userId);
    const laterRow = await rawUserRow(later.userId);
    expect(Date.parse(String(soonRow?.watch_expiration))).toBeGreaterThan(Date.now() + 24 * 3600_000);
    expect(Date.parse(String(laterRow?.watch_expiration))).toBeLessThan(Date.now() + 6 * 24 * 3600_000);
  });

  it('401 UNAUTHENTICATED: no or wrong bearer', async () => {
    const app = buildApp();
    for (const secret of [undefined, 'wrong']) {
      const response = await app.handlers.renewWatch(cron(secret));
      expect(response.status).toBe(401);
      await expect(envelope(response)).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    }
  });

  it('500 INTERNAL: CRON_SECRET not configured', async () => {
    const app = buildApp();
    app.deps.cronSecret = undefined;
    const response = await app.handlers.renewWatch(cron(CRON_SECRET));
    expect(response.status).toBe(500);
  });
});

describe('CORS preflight (§3.2)', () => {
  it('204 with the frontend origin', async () => {
    const response = await buildApp().handlers.options(new Request('https://api.vibemail.test/api/v1/messages', { method: 'OPTIONS' }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(FRONTEND_URL);
  });
});
