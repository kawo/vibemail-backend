import { ProviderError } from '../../src/providers/provider';
import {
  type WebhookDeps,
  decodeNotification,
  handleGmailPush,
  processNotification,
  verifyPushToken,
} from '../../src/webhook/gmail';
import { createFakeProviderFactory, cursor, fakeMessage } from '../fakes/fakeProvider';
import { MemoryMessages, MemoryUsers } from '../fakes/memoryRepos';

const TOKEN = 'a'.repeat(40);
const USER = 'user-1';
const EMAIL = 'me@example.com';

function pushBody(data: object | string) {
  const encoded = typeof data === 'string' ? data : Buffer.from(JSON.stringify(data)).toString('base64');
  return { message: { data: encoded, messageId: '1', publishTime: '2026-10-06T10:00:00Z' }, subscription: 's' };
}

function request(body: unknown, token: string | null = TOKEN): Request {
  const url = `https://vibemail.test/webhook/gmail${token === null ? '' : `?token=${token}`}`;
  return new Request(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
}

function setup(storedHistoryId: string | null = '100') {
  const { factory, box } = createFakeProviderFactory();
  const users = new MemoryUsers();
  users.rows.set(USER, {
    googleId: 'g',
    userId: USER,
    email: EMAIL,
    scopes: [],
    credentials: { refreshToken: 'r', accessToken: null, accessTokenExpiresAt: null },
    historyId: storedHistoryId,
    lastSyncedAt: null,
  });
  const messages = new MemoryMessages();
  const pending: Array<Promise<unknown>> = [];
  const log = jest.fn();
  const deps: WebhookDeps = {
    factory,
    users,
    messages,
    verificationToken: TOKEN,
    waitUntil: (p) => {
      pending.push(p);
    },
    log,
  };
  return { deps, box, users, messages, pending, log };
}

describe('handleGmailPush (CONTRACT.md §4.5)', () => {
  it('acks with 200 before the sync runs, and hands the sync to waitUntil', async () => {
    const { deps, box, pending } = setup();
    box.forbidCalls = true; // proves nothing ran synchronously before the response
    const response = await handleGmailPush(request(pushBody({ emailAddress: EMAIL, historyId: 200 })), deps);
    expect(response.status).toBe(200);
    expect(pending).toHaveLength(1);
    expect(box.calls).toEqual([]);
  });

  it('rejects a wrong or missing token with 401 and schedules nothing', async () => {
    const { deps, pending } = setup();
    const wrong = await handleGmailPush(request(pushBody({ emailAddress: EMAIL, historyId: 1 }), 'b'.repeat(40)), deps);
    const missing = await handleGmailPush(request(pushBody({ emailAddress: EMAIL, historyId: 1 }), null), deps);
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    await expect(wrong.json()).resolves.toMatchObject({ error: { code: 'UNAUTHENTICATED', retryable: false } });
    expect(pending).toEqual([]);
  });

  it('fails closed with 500 when the token is not configured', async () => {
    const { deps, log } = setup();
    const response = await handleGmailPush(request(pushBody({ emailAddress: EMAIL, historyId: 1 })), {
      ...deps,
      verificationToken: '',
    });
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalled();
  });

  it.each([
    ['not JSON', '{nope'],
    ['no message', { subscription: 's' }],
    ['data not base64 JSON', pushBody('%%%')],
    ['missing historyId', pushBody({ emailAddress: EMAIL })],
  ])('rejects a body with %s as 400 VALIDATION_FAILED', async (_name, body) => {
    const { deps, pending } = setup();
    const response = await handleGmailPush(request(body), deps);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    expect(pending).toEqual([]);
  });

  it('logs background failures instead of rejecting', async () => {
    const { deps, box, pending, log } = setup();
    box.failNext.set('listChanges', new ProviderError('upstream', 'boom'));
    await handleGmailPush(request(pushBody({ emailAddress: EMAIL, historyId: 200 })), deps);
    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(log).toHaveBeenCalledWith('webhook sync failed after ack', expect.any(ProviderError));
  });
});

describe('processNotification', () => {
  it('syncs the delta from the stored history_id, not the notification historyId', async () => {
    const { deps, box, users, messages } = setup('100');
    box.messages.set('new', fakeMessage({ id: 'new' }));
    box.changePages.set(
      '100',
      new Map([['', { changes: [{ type: 'messageAdded', messageId: 'new' }], nextPageToken: null, cursor: cursor(250) }]]),
    );
    await expect(processNotification(deps, { emailAddress: EMAIL, historyId: cursor(200) })).resolves.toBe(
      'incremental_sync',
    );
    const listCalls = box.calls.filter((c) => c.method === 'listChanges');
    expect(listCalls.map((c) => c.args[0])).toEqual(['100']);
    expect(messages.forUser(USER).map((r) => r.gmail_id)).toEqual(['new']);
    // Saved from the history.list response, not the notification.
    expect(users.rows.get(USER)?.historyId).toBe('250');
  });

  it('ignores a duplicate or out-of-order notification with no provider call', async () => {
    const { deps, box } = setup('100');
    box.forbidCalls = true;
    await expect(processNotification(deps, { emailAddress: EMAIL, historyId: cursor(100) })).resolves.toBe('stale');
    await expect(processNotification(deps, { emailAddress: EMAIL, historyId: cursor(99) })).resolves.toBe('stale');
    expect(box.calls).toEqual([]);
  });

  it('ignores an unknown mailbox', async () => {
    const { deps, box } = setup();
    box.forbidCalls = true;
    await expect(processNotification(deps, { emailAddress: 'else@example.com', historyId: cursor(1) })).resolves.toBe(
      'unknown_account',
    );
  });

  it('runs a full sync when no history_id is stored yet', async () => {
    const { deps, box, users } = setup(null);
    box.messages.set('m1', fakeMessage({ id: 'm1', syncCursor: cursor(300) }));
    await expect(processNotification(deps, { emailAddress: EMAIL, historyId: cursor(5) })).resolves.toBe('full_sync');
    expect(users.rows.get(USER)?.historyId).toBe('300');
  });

  it('falls back to a full sync when the stored history_id has expired', async () => {
    const { deps, box, users } = setup('100');
    box.expiredBefore = cursor(150);
    box.messages.set('m1', fakeMessage({ id: 'm1', syncCursor: cursor(400) }));
    await expect(processNotification(deps, { emailAddress: EMAIL, historyId: cursor(200) })).resolves.toBe(
      'fallback_full_sync',
    );
    expect(users.rows.get(USER)?.historyId).toBe('400');
  });

  it('clears stored tokens when Google reports the grant revoked', async () => {
    const { deps, box, users } = setup('100');
    box.failNext.set('listChanges', new ProviderError('revoked', 'invalid_grant'));
    await expect(processNotification(deps, { emailAddress: EMAIL, historyId: cursor(200) })).resolves.toBe('revoked');
    expect(users.cleared).toEqual([USER]);
  });
});

describe('helpers', () => {
  it('compares the token in constant time and fails closed when unset', () => {
    expect(() => verifyPushToken(TOKEN, TOKEN)).not.toThrow();
    expect(() => verifyPushToken('short', TOKEN)).toThrow(/invalid/);
    expect(() => verifyPushToken(TOKEN, undefined)).toThrow(/not configured/);
  });

  it('decodes numeric or string historyId', () => {
    expect(decodeNotification(pushBody({ emailAddress: EMAIL, historyId: 9876543210 }))).toEqual({
      emailAddress: EMAIL,
      historyId: '9876543210',
    });
    expect(decodeNotification(pushBody({ emailAddress: EMAIL, historyId: '42' })).historyId).toBe('42');
  });
});
