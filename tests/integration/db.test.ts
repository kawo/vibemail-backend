/**
 * The database layer's named operations against the LIVE database (src/db/index.ts):
 * upsertMessage, getUser, updateUserTokens, updateHistoryId, updateWatchExpiry.
 */
import { createDb, decryptToken } from '../../src/db';
import { fakeMessage } from '../fakes/fakeProvider';
import {
  ENCRYPTION_KEY,
  admin,
  createTestUser,
  cursor,
  deleteTestUsers,
  rawMessageRows,
  rawUserRow,
  seedConnectedUser,
  buildApp,
} from './support';

jest.setTimeout(60_000);
afterAll(deleteTestUsers);

const db = () => createDb(admin(), ENCRYPTION_KEY);

describe('messages.upsertMessage', () => {
  it('maps from/to to from_address/to_address and upserts on (user_id, gmail_id)', async () => {
    const user = await createTestUser();
    await seedConnectedUser(buildApp(), user);
    const message = fakeMessage({
      id: 'up1',
      from: 'Ada <ada@vibemail.test>',
      to: ['a@vibemail.test', 'Bob <b@vibemail.test>'],
      labels: ['INBOX', 'STARRED'],
      bodyText: 'plain',
      syncCursor: cursor(77),
    });
    await db().messages.upsertMessage(user.userId, message, new Date());
    // Same message after Gmail un-starred it: flags are recomputed by the normaliser.
    await db().messages.upsertMessage(user.userId, fakeMessage({ ...message, labels: ['INBOX'], isStarred: false }), new Date());

    const rows = await rawMessageRows(user.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      gmail_id: 'up1',
      from_address: 'Ada <ada@vibemail.test>',
      to_address: ['a@vibemail.test', 'Bob <b@vibemail.test>'],
      body_plain: 'plain',
      history_id: '77',
      label_ids: ['INBOX'],
      is_starred: false,
    });
  });

  it('keeps two users holding the same gmail_id apart', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    await seedConnectedUser(buildApp(), a);
    await seedConnectedUser(buildApp(), b);
    await db().messages.upsertMessage(a.userId, fakeMessage({ id: 'shared1', subject: 'A' }), new Date());
    await db().messages.upsertMessage(b.userId, fakeMessage({ id: 'shared1', subject: 'B' }), new Date());
    await expect(rawMessageRows(a.userId)).resolves.toEqual([expect.objectContaining({ subject: 'A' })]);
    await expect(rawMessageRows(b.userId)).resolves.toEqual([expect.objectContaining({ subject: 'B' })]);
  });
});

describe('users operations', () => {
  it('getUser returns the stored row, tokens still encrypted', async () => {
    const user = await createTestUser();
    await seedConnectedUser(buildApp(), user);
    const row = await db().users.getUser(user.userId);
    expect(row).toMatchObject({ user_id: user.userId, google_id: user.googleId, email: user.email, name: 'Test User' });
    expect(row?.refresh_token).toMatch(/^v1:/);
    await expect(db().users.getUser('00000000-0000-0000-0000-000000000000')).resolves.toBeNull();
  });

  it('updateUserTokens encrypts and writes the access token, expiry and a rotated refresh token', async () => {
    const user = await createTestUser();
    await seedConnectedUser(buildApp(), user);
    const expiresAt = new Date(Date.now() + 7200_000);
    await db().users.updateUserTokens(user.userId, { accessToken: 'new-a', accessTokenExpiresAt: expiresAt, refreshToken: 'new-r' });
    const row = await rawUserRow(user.userId);
    expect(decryptToken(String(row?.access_token), ENCRYPTION_KEY)).toBe('new-a');
    expect(decryptToken(String(row?.refresh_token), ENCRYPTION_KEY)).toBe('new-r');
    expect(Date.parse(String(row?.access_token_expires_at))).toBe(expiresAt.getTime());
  });

  it('updateHistoryId writes history_id and last_synced_at', async () => {
    const user = await createTestUser();
    await seedConnectedUser(buildApp(), user);
    const at = new Date('2026-10-07T08:00:00.000Z');
    await db().users.updateHistoryId(user.userId, '123456', at);
    const row = await rawUserRow(user.userId);
    expect(row?.history_id).toBe('123456');
    expect(Date.parse(String(row?.last_synced_at))).toBe(at.getTime());
  });

  it('updateWatchExpiry writes watch_expiration', async () => {
    const user = await createTestUser();
    await seedConnectedUser(buildApp(), user);
    const expiresAt = new Date('2026-10-14T06:00:00.000Z');
    await db().users.updateWatchExpiry(user.userId, expiresAt);
    expect(Date.parse(String((await rawUserRow(user.userId))?.watch_expiration))).toBe(expiresAt.getTime());
  });
});
