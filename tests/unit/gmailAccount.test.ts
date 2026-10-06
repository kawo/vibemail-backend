import type { ConnectedUserInput, UpsertResult, UsersRepository } from '../../src/db/users';
import { TokenDecryptionError } from '../../src/db/crypto';
import { GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE } from '../../src/providers/gmail/auth';
import { type AccountCredentials, type TokenUpdate, type VerifiedGrant, ProviderError } from '../../src/providers/provider';
import {
  connectGmailAccount,
  providerForUser,
  refreshUserAccessToken,
} from '../../src/services/gmailAccount';
import { createFakeProviderFactory } from '../fakes/fakeProvider';

class MemoryUsers implements UsersRepository {
  rows = new Map<string, ConnectedUserInput & { watch?: Date }>();
  tokenWrites: Array<[string, TokenUpdate]> = [];
  upsertResult: UpsertResult = 'ok';
  cleared: string[] = [];
  throwOnRead: Error | null = null;

  async upsertConnectedUser(input: ConnectedUserInput): Promise<UpsertResult> {
    if (this.upsertResult === 'ok') {
      this.rows.set(input.userId, input);
    }
    return this.upsertResult;
  }
  async updateUserTokens(userId: string, update: TokenUpdate): Promise<void> {
    this.tokenWrites.push([userId, update]);
  }
  async getUserCredentials(userId: string): Promise<AccountCredentials | null> {
    if (this.throwOnRead) {
      throw this.throwOnRead;
    }
    return this.rows.get(userId)?.credentials ?? null;
  }
  async updateWatch(userId: string, expiresAt: Date): Promise<void> {
    const row = this.rows.get(userId);
    if (row) {
      row.watch = expiresAt;
    }
  }
  async clearUserTokens(userId: string): Promise<void> {
    this.cleared.push(userId);
  }
}

const goodGrant: VerifiedGrant = {
  accountId: 'google-123',
  email: 'Me@Example.com',
  scopes: [GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE],
  credentials: { refreshToken: 'r', accessToken: 'a', accessTokenExpiresAt: new Date(Date.now() + 3600_000) },
};
const input = { userId: 'user-1', claimsEmail: 'me@example.com', providerRefreshToken: 'r' };

function setup(grant: VerifiedGrant = goodGrant) {
  const { factory, box } = createFakeProviderFactory(undefined, { grant });
  const users = new MemoryUsers();
  const log = jest.fn();
  return { deps: { factory, users, log }, users, box, log };
}

describe('connectGmailAccount (CONTRACT.md §4.1)', () => {
  it('stores the account keyed by google_id and registers the watch', async () => {
    const { deps, users, box } = setup();
    const result = await connectGmailAccount(deps, input);
    expect(result.email).toBe('Me@Example.com');
    expect(result.watchExpiration).toBeInstanceOf(Date);
    const row = users.rows.get('user-1');
    expect(row).toMatchObject({ googleId: 'google-123', userId: 'user-1', credentials: goodGrant.credentials });
    expect(row?.watch).toEqual(result.watchExpiration);
    expect(box.calls.map((c) => c.method)).toEqual(['watch']);
  });

  it('maps a revoked refresh token to GMAIL_TOKEN_REVOKED without writing', async () => {
    const { deps, users } = setup();
    jest.spyOn(deps.factory, 'verifyRefreshToken').mockRejectedValue(new ProviderError('revoked', 'invalid_grant'));
    await expect(connectGmailAccount(deps, input)).rejects.toMatchObject({ code: 'GMAIL_TOKEN_REVOKED' });
    expect(users.rows.size).toBe(0);
  });

  it.each([
    ['no email', { ...goodGrant, email: null }, 'GMAIL_NOT_CONNECTED', { missingScopes: ['email'] }],
    ['no sub', { ...goodGrant, accountId: null }, 'GMAIL_NOT_CONNECTED', { missingScopes: ['email'] }],
    ['other email', { ...goodGrant, email: 'else@example.com' }, 'VALIDATION_FAILED', { reason: 'EMAIL_MISMATCH' }],
    ['missing send', { ...goodGrant, scopes: [GMAIL_MODIFY_SCOPE] }, 'GMAIL_NOT_CONNECTED', { missingScopes: [GMAIL_SEND_SCOPE] }],
  ])('rejects %s without writing', async (_name, grant, code, details) => {
    const { deps, users } = setup(grant);
    await expect(connectGmailAccount(deps, input)).rejects.toMatchObject({ code, details });
    expect(users.rows.size).toBe(0);
  });

  it.each([
    ['google_account_linked_elsewhere', 'GOOGLE_ACCOUNT_LINKED_ELSEWHERE'],
    ['another_google_account_linked', 'ANOTHER_GOOGLE_ACCOUNT_LINKED'],
  ] as const)('maps the %s linking conflict', async (outcome, reason) => {
    const { deps, users, box } = setup();
    users.upsertResult = outcome;
    await expect(connectGmailAccount(deps, input)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason },
    });
    expect(box.calls).toEqual([]);
  });

  it('still succeeds when watch fails, with watchExpiration null', async () => {
    const { deps, box, log } = setup();
    box.failNext.set('watch', new ProviderError('upstream', 'pubsub denied'));
    await expect(connectGmailAccount(deps, input)).resolves.toMatchObject({ watchExpiration: null });
    expect(log).toHaveBeenCalled();
  });
});

describe('refreshUserAccessToken', () => {
  it('reads stored credentials, refreshes, and persists via updateUserTokens', async () => {
    const { deps, users } = setup();
    await connectGmailAccount(deps, input);
    const update = await refreshUserAccessToken(deps, 'user-1');
    expect(users.tokenWrites).toEqual([['user-1', update]]);
  });

  it('clears stored tokens and reports GMAIL_TOKEN_REVOKED on revocation', async () => {
    const { deps, users, box } = setup();
    await connectGmailAccount(deps, input);
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
