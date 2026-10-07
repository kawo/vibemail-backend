/**
 * OAuth token storage against the LIVE database (CONTRACT.md §3.1, §5.2, §5.4): encryption at
 * rest, persistence, and the token persistence listener writing every refresh immediately.
 */
import { decryptToken } from '../../src/db/crypto';
import { type GmailAuthConfig, bindAccount } from '../../src/providers/gmail/auth';
import { persistTokensFor } from '../../src/services/gmailAccount';
import {
  ENCRYPTION_KEY,
  admin,
  buildApp,
  createTestUser,
  deleteTestUsers,
  grantFor,
  rawUserRow,
  seedConnectedUser,
} from './support';

jest.setTimeout(60_000);
afterAll(deleteTestUsers);

const config: GmailAuthConfig = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  redirectUri: 'http://localhost:3000/api/v1/auth/google/callback',
  pubsubTopic: 'projects/p/topics/t',
};

describe('token encryption at rest', () => {
  it('stores ciphertext only, decryptable with ENCRYPTION_KEY', async () => {
    const user = await createTestUser();
    await seedConnectedUser(buildApp(), user);
    const row = await rawUserRow(user.userId);
    const grant = grantFor(user);
    for (const [column, plain] of [
      ['refresh_token', grant.credentials.refreshToken],
      ['access_token', grant.credentials.accessToken],
    ] as const) {
      const stored = String(row?.[column]);
      expect(stored).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
      expect(stored).not.toContain(String(plain));
      expect(decryptToken(stored, ENCRYPTION_KEY)).toBe(plain);
    }
  });

  it('reads back decrypted credentials through the repository', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user);
    await expect(app.deps.users.getUserCredentials(user.userId)).resolves.toEqual(grantFor(user).credentials);
  });

  it('the DB rejects an access token without its expiry (pairing CHECK)', async () => {
    const user = await createTestUser();
    await seedConnectedUser(buildApp(), user);
    const { error } = await admin().from('users').update({ access_token_expires_at: null }).eq('user_id', user.userId);
    expect(error).not.toBeNull();
  });
});

describe('token persistence listener', () => {
  it('writes every refresh to the DB immediately, keeping the access token and expiry paired', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user);
    const bound = bindAccount(config, grantFor(user).credentials, persistTokensFor(app.deps.users, user.userId));

    const expiry = Date.now() + 3600_000;
    bound.client.emit('tokens', { access_token: 'refreshed-access', expiry_date: expiry });
    await bound.pendingWrites();

    const row = await rawUserRow(user.userId);
    expect(decryptToken(String(row?.access_token), ENCRYPTION_KEY)).toBe('refreshed-access');
    expect(Date.parse(String(row?.access_token_expires_at))).toBe(expiry);
    // No rotated refresh token in the event: the stored one is kept.
    expect(decryptToken(String(row?.refresh_token), ENCRYPTION_KEY)).toBe(grantFor(user).credentials.refreshToken);
  });

  it('persists a rotated refresh token', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user);
    const bound = bindAccount(config, grantFor(user).credentials, persistTokensFor(app.deps.users, user.userId));
    bound.client.emit('tokens', { access_token: 'a2', expiry_date: Date.now() + 3600_000, refresh_token: 'rotated' });
    await bound.pendingWrites();
    const row = await rawUserRow(user.userId);
    expect(decryptToken(String(row?.refresh_token), ENCRYPTION_KEY)).toBe('rotated');
  });

  it('never persists an access token without an expiry', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user);
    const before = await rawUserRow(user.userId);
    const bound = bindAccount(config, grantFor(user).credentials, persistTokensFor(app.deps.users, user.userId));
    bound.client.emit('tokens', { access_token: 'no-expiry' });
    await bound.pendingWrites();
    const after = await rawUserRow(user.userId);
    expect(after?.access_token).toBe(before?.access_token);
  });
});
