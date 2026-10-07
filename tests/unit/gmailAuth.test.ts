import { Auth } from 'googleapis';
import {
  type GmailAuthConfig,
  GMAIL_MODIFY_SCOPE,
  GMAIL_SEND_SCOPE,
  bindAccount,
  buildAuthorizationUrl,
  refreshBoundAccessToken,
  toProviderError,
  toTokenUpdate,
  verifyRefreshToken,
  watchInbox,
} from '../../src/providers/gmail/auth';
import { compareHistoryIds } from '../../src/providers/gmail/provider';
import { ProviderError, type SyncCursor, type TokenUpdate } from '../../src/providers/provider';

const config: GmailAuthConfig = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://localhost:3000/api/v1/auth/google/callback',
  pubsubTopic: 'projects/p/topics/t',
};

const creds = { refreshToken: 'refresh-1', accessToken: null, accessTokenExpiresAt: null };
const later = Date.now() + 3600_000;

afterEach(() => jest.restoreAllMocks());

/** Makes refreshAccessToken behave like the real client: set credentials and emit 'tokens'. */
function stubRefresh(tokens: Auth.Credentials) {
  return jest
    .spyOn(Auth.OAuth2Client.prototype, 'refreshAccessToken')
    .mockImplementation(async function (this: Auth.OAuth2Client) {
      this.credentials = { ...this.credentials, ...tokens };
      this.emit('tokens', tokens);
      return { credentials: this.credentials, res: null };
    } as never);
}

describe('toTokenUpdate', () => {
  it('pairs access token and expiry, and carries a rotated refresh token', () => {
    expect(toTokenUpdate({ access_token: 'a', expiry_date: later, refresh_token: 'r2' })).toEqual({
      accessToken: 'a',
      accessTokenExpiresAt: new Date(later),
      refreshToken: 'r2',
    });
  });

  it('refuses an access token without expiry', () => {
    expect(toTokenUpdate({ access_token: 'a' })).toBeNull();
  });
});

describe('token persistence listener', () => {
  it('persists every refresh through onTokens immediately, in order', async () => {
    const updates: TokenUpdate[] = [];
    const bound = bindAccount(config, creds, async (u) => {
      updates.push(u);
    });
    bound.client.emit('tokens', { access_token: 'a1', expiry_date: later });
    bound.client.emit('tokens', { access_token: 'a2', expiry_date: later, refresh_token: 'r2' });
    await bound.pendingWrites();
    expect(updates.map((u) => [u.accessToken, u.refreshToken])).toEqual([
      ['a1', undefined],
      ['a2', 'r2'],
    ]);
  });

  it('skips incomplete token events', async () => {
    const onTokens = jest.fn(async () => {});
    const bound = bindAccount(config, creds, onTokens);
    bound.client.emit('tokens', { access_token: 'no-expiry' });
    await bound.pendingWrites();
    expect(onTokens).not.toHaveBeenCalled();
  });

  it('surfaces a failed write on the next pendingWrites()', async () => {
    const bound = bindAccount(config, creds, async () => {
      throw new Error('db down');
    });
    bound.client.emit('tokens', { access_token: 'a', expiry_date: later });
    await expect(bound.pendingWrites()).rejects.toMatchObject({ kind: 'upstream' });
    await expect(bound.pendingWrites()).resolves.toBeUndefined();
  });

  it('seeds the access token only as a complete pair', () => {
    const half = bindAccount(config, { refreshToken: 'r', accessToken: 'a', accessTokenExpiresAt: null }, jest.fn());
    expect(half.client.credentials.access_token).toBeUndefined();
    const full = bindAccount(config, { refreshToken: 'r', accessToken: 'a', accessTokenExpiresAt: new Date(later) }, jest.fn());
    expect(full.client.credentials).toMatchObject({ access_token: 'a', expiry_date: later, refresh_token: 'r' });
  });
});

describe('refreshBoundAccessToken', () => {
  it('returns the update only after it has been persisted', async () => {
    stubRefresh({ access_token: 'fresh', expiry_date: later });
    const persisted: string[] = [];
    const bound = bindAccount(config, creds, async (u) => {
      persisted.push(u.accessToken);
    });
    const update = await refreshBoundAccessToken(bound);
    expect(update.accessToken).toBe('fresh');
    expect(persisted).toEqual(['fresh']);
    expect(bound.client.credentials.refresh_token).toBe('refresh-1');
  });

  it('maps invalid_grant to revoked', async () => {
    jest
      .spyOn(Auth.OAuth2Client.prototype, 'refreshAccessToken')
      .mockRejectedValue({ response: { status: 400, data: { error: 'invalid_grant' } } } as never);
    const bound = bindAccount(config, creds, jest.fn());
    await expect(refreshBoundAccessToken(bound)).rejects.toMatchObject({ kind: 'revoked' });
  });
});

describe('verifyRefreshToken', () => {
  it('proves the token and reports identity, scopes and credentials', async () => {
    stubRefresh({ access_token: 'fresh', expiry_date: later });
    jest.spyOn(Auth.OAuth2Client.prototype, 'getTokenInfo').mockResolvedValue({
      aud: 'client-id',
      scopes: [GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE],
      expiry_date: later,
      sub: 'google-123',
      email: 'me@example.com',
    });
    await expect(verifyRefreshToken(config, 'given-refresh')).resolves.toEqual({
      accountId: 'google-123',
      email: 'me@example.com',
      scopes: [GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE],
      credentials: { refreshToken: 'given-refresh', accessToken: 'fresh', accessTokenExpiresAt: new Date(later) },
    });
  });

  it('keeps a rotated refresh token', async () => {
    stubRefresh({ access_token: 'fresh', expiry_date: later, refresh_token: 'rotated' });
    jest
      .spyOn(Auth.OAuth2Client.prototype, 'getTokenInfo')
      .mockResolvedValue({ aud: 'c', scopes: [], expiry_date: later });
    const grant = await verifyRefreshToken(config, 'given-refresh');
    expect(grant.credentials.refreshToken).toBe('rotated');
    expect(grant.email).toBeNull();
    expect(grant.accountId).toBeNull();
  });
});

describe('watchInbox', () => {
  it('calls users.watch with the topic and INCLUDE filter, and returns cursor and expiry', async () => {
    const bound = bindAccount(config, { ...creds, accessToken: 'a', accessTokenExpiresAt: new Date(later) }, jest.fn());
    const request = jest
      .spyOn(bound.client, 'request')
      .mockResolvedValue({ data: { historyId: '987', expiration: String(later) } } as never);
    const result = await watchInbox(config, bound);
    expect(result).toEqual({ cursor: '987', expiresAt: new Date(later) });
    const call = request.mock.calls[0]?.[0] as { url: string; data: unknown };
    expect(call.url).toContain('/gmail/v1/users/me/watch');
    expect(call.data).toEqual({ topicName: config.pubsubTopic, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' });
  });
});

describe('toProviderError', () => {
  it.each([
    [{ response: { status: 400, data: { error: 'invalid_grant' } } }, 'revoked'],
    [{ response: { status: 429, headers: { 'retry-after': '12' } } }, 'rate_limited'],
    [{ response: { status: 403, data: { error: { errors: [{ reason: 'userRateLimitExceeded' }] } } } }, 'rate_limited'],
    [{ response: { status: 404 } }, 'not_found'],
    [{ response: { status: 500 } }, 'upstream'],
    [new Error('socket hang up'), 'upstream'],
  ])('maps %j to %s', (input, kind) => {
    expect(toProviderError(input, 'ctx').kind).toBe(kind);
  });

  it('keeps Retry-After and passes ProviderError through', () => {
    expect(toProviderError({ response: { status: 429, headers: { 'retry-after': '12' } } }, 'c').retryAfterSeconds).toBe(12);
    const original = new ProviderError('not_found', 'x');
    expect(toProviderError(original, 'c')).toBe(original);
  });
});

describe('Gmail factory', () => {
  it('compares history IDs numerically, beyond 2^53', () => {
    const c = (v: string) => v as SyncCursor;
    expect(compareHistoryIds(c('9'), c('10'))).toBe(-1);
    expect(compareHistoryIds(c('18446744073709551615'), c('18446744073709551614'))).toBe(1);
    expect(compareHistoryIds(c('42'), c('42'))).toBe(0);
  });

  it('builds an offline consent URL with state', () => {
    const url = new URL(buildAuthorizationUrl(config, { state: 'abc', scopes: ['email'], loginHint: 'me@example.com' }));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('login_hint')).toBe('me@example.com');
    expect(url.searchParams.get('client_id')).toBe('client-id');
  });
});
