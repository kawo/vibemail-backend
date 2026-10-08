import { TokenDecryptionError } from '../../src/db/crypto';
import { GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE } from '../../src/providers/gmail/auth';
import { type VerifiedGrant, ProviderError } from '../../src/providers/provider';
import {
  providerForUser,
  refreshUserAccessToken,
  signInWithGoogle,
} from '../../src/services/gmailAccount';
import { createFakeProviderFactory, cursor, fakeMessage } from '../fakes/fakeProvider';
import { FakeSessions, SessionError } from '../fakes/fakeSessions';
import { MemoryMessages, MemoryUsers } from '../fakes/memoryRepos';

const goodGrant: VerifiedGrant = {
  accountId: 'google-123',
  email: 'Me@Example.com',
  name: 'Me Example',
  idToken: 'id-token-1',
  scopes: [GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE],
  credentials: { refreshToken: 'r', accessToken: 'a', accessTokenExpiresAt: new Date(Date.now() + 3600_000) },
};
const input = { code: 'auth-code' };

function setup(grant: VerifiedGrant = goodGrant) {
  const { factory, box } = createFakeProviderFactory(undefined, { grant });
  const users = new MemoryUsers();
  const messages = new MemoryMessages();
  const sessions = new FakeSessions({ userId: 'user-1', email: 'me@example.com' });
  const log = jest.fn();
  return { deps: { factory, users, messages, sessions, log }, users, messages, sessions, box, log };
}

describe('signInWithGoogle (CONTRACT.md §4.1b)', () => {
  it('signs in with the ID token, stores the account keyed by google_id, and registers the watch', async () => {
    const { deps, users, sessions, box } = setup();
    const result = await signInWithGoogle(deps, input);
    expect(sessions.calls).toEqual([{ idToken: 'id-token-1', accessToken: 'a' }]);
    expect(result.session).toMatchObject({ userId: 'user-1', accessToken: 'sb-access-user-1', refreshToken: 'sb-refresh-user-1' });
    expect(result.email).toBe('Me@Example.com');
    expect(result.watchExpiration).toBeInstanceOf(Date);
    const row = users.rows.get('user-1');
    expect(row).toMatchObject({
      googleId: 'google-123',
      userId: 'user-1',
      email: 'Me@Example.com',
      name: 'Me Example',
      credentials: goodGrant.credentials,
    });
    expect(row?.watch).toEqual(result.watchExpiration);
    expect(result.initialSync).toBe('completed');
    expect(box.calls.map((c) => c.method)).toEqual(['watch', 'listInboxMessageIds']);
  });

  it('runs the initial sync after storing tokens (step 8)', async () => {
    const { deps, users, messages, box } = setup();
    box.messages.set('m1', fakeMessage({ id: 'm1', syncCursor: cursor(77) }));
    await expect(signInWithGoogle(deps, input)).resolves.toMatchObject({ initialSync: 'completed' });
    expect(messages.forUser('user-1').map((r) => r.gmail_id)).toEqual(['m1']);
    expect(users.rows.get('user-1')?.historyId).toBe('77');
  });

  it('still succeeds when the initial sync fails, leaving history_id null', async () => {
    const { deps, users, box, log } = setup();
    box.failNext.set('listInboxMessageIds', new ProviderError('upstream', 'boom'));
    await expect(signInWithGoogle(deps, input)).resolves.toMatchObject({ initialSync: 'failed' });
    expect(users.rows.get('user-1')?.historyId).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  it('maps a rejected authorization code to GMAIL_TOKEN_REVOKED without signing in or writing', async () => {
    const { deps, users, sessions } = setup();
    jest.spyOn(deps.factory, 'exchangeAuthorizationCode').mockRejectedValue(new ProviderError('revoked', 'invalid_grant'));
    await expect(signInWithGoogle(deps, input)).rejects.toMatchObject({ code: 'GMAIL_TOKEN_REVOKED' });
    expect(sessions.calls).toEqual([]);
    expect(users.rows.size).toBe(0);
  });

  it.each([
    ['no refresh token', { ...goodGrant, credentials: { ...goodGrant.credentials, refreshToken: '' } }, 'GMAIL_NOT_CONNECTED', { reason: 'no_refresh_token' }],
    ['no email', { ...goodGrant, email: null }, 'GMAIL_NOT_CONNECTED', { reason: 'missing_email_scope', missingScopes: ['email'] }],
    ['no sub', { ...goodGrant, accountId: null }, 'GMAIL_NOT_CONNECTED', { reason: 'missing_email_scope', missingScopes: ['email'] }],
    ['no ID token', { ...goodGrant, idToken: null }, 'GMAIL_NOT_CONNECTED', { reason: 'missing_openid_scope', missingScopes: ['openid'] }],
    ['missing send', { ...goodGrant, scopes: [GMAIL_MODIFY_SCOPE] }, 'GMAIL_NOT_CONNECTED', { reason: 'missing_gmail_scope', missingScopes: [GMAIL_SEND_SCOPE] }],
  ])('rejects %s before signing in, without writing', async (_name, grant, code, details) => {
    const { deps, users, sessions } = setup(grant);
    await expect(signInWithGoogle(deps, input)).rejects.toMatchObject({ code, details });
    expect(sessions.calls).toEqual([]);
    expect(users.rows.size).toBe(0);
  });

  it('rejects a Supabase user whose email differs from the Google account', async () => {
    const { deps, users, sessions } = setup();
    sessions.users.set('id-token-1', { userId: 'user-9', email: 'else@example.com' });
    await expect(signInWithGoogle(deps, input)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'EMAIL_MISMATCH' },
    });
    expect(users.rows.size).toBe(0);
  });

  it('reports a Supabase sign-in failure as INTERNAL SUPABASE_SIGN_IN_FAILED, logged, without writing', async () => {
    const { deps, users, sessions, log } = setup();
    const failure = new SessionError('Supabase sign-in failed: Provider not enabled', null);
    sessions.fail = failure;
    await expect(signInWithGoogle(deps, input)).rejects.toMatchObject({
      code: 'INTERNAL',
      details: { reason: 'SUPABASE_SIGN_IN_FAILED' },
    });
    expect(log).toHaveBeenCalledWith('Supabase sign-in failed', failure);
    expect(users.rows.size).toBe(0);
  });

  it.each([
    ['google_account_linked_elsewhere', 'GOOGLE_ACCOUNT_LINKED_ELSEWHERE'],
    ['another_google_account_linked', 'ANOTHER_GOOGLE_ACCOUNT_LINKED'],
  ] as const)('maps the %s linking conflict', async (outcome, reason) => {
    const { deps, users, box } = setup();
    users.upsertResult = outcome;
    await expect(signInWithGoogle(deps, input)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason },
    });
    expect(box.calls).toEqual([]);
  });

  it('still succeeds when watch fails, with watchExpiration null', async () => {
    const { deps, box, log } = setup();
    box.failNext.set('watch', new ProviderError('upstream', 'pubsub denied'));
    await expect(signInWithGoogle(deps, input)).resolves.toMatchObject({ watchExpiration: null });
    expect(log).toHaveBeenCalled();
  });
});

describe('refreshUserAccessToken', () => {
  it('reads stored credentials, refreshes, and persists via updateUserTokens', async () => {
    const { deps, users } = setup();
    await signInWithGoogle(deps, input);
    const update = await refreshUserAccessToken(deps, 'user-1');
    expect(users.tokenWrites).toEqual([['user-1', update]]);
  });

  it('clears stored tokens and reports GMAIL_TOKEN_REVOKED on revocation', async () => {
    const { deps, users, box } = setup();
    await signInWithGoogle(deps, input);
    box.failNext.set('refreshAccessToken', new ProviderError('revoked', 'invalid_grant'));
    await expect(refreshUserAccessToken(deps, 'user-1')).rejects.toMatchObject({ code: 'GMAIL_TOKEN_REVOKED' });
    expect(users.cleared).toEqual(['user-1']);
  });
});

describe('providerForUser', () => {
  it('requires a connected account', async () => {
    const { deps } = setup();
    await expect(providerForUser(deps, 'nobody')).rejects.toMatchObject({ code: 'GMAIL_NOT_CONNECTED' });
  });

  it('treats undecryptable stored tokens as revoked', async () => {
    const { deps, users } = setup();
    users.throwOnRead = new TokenDecryptionError('authentication failed');
    await expect(providerForUser(deps, 'user-1')).rejects.toMatchObject({ code: 'GMAIL_TOKEN_REVOKED' });
  });
});
