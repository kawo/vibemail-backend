import { ProviderError } from '../../src/providers/provider';
import { INITIAL_SYNC_LIMIT, runInitialSync, toMessageRow } from '../../src/sync';
import { createFakeProviderFactory, cursor, fakeMessage } from '../fakes/fakeProvider';
import { MemoryMessages, MemoryUsers } from '../fakes/memoryRepos';

const USER = 'user-1';
const syncedAt = new Date('2026-10-06T10:00:00.000Z');

function setup(messageCount: number) {
  const { factory, box } = createFakeProviderFactory();
  for (let i = 0; i < messageCount; i += 1) {
    // Higher i = newer message and newer history ID.
    box.messages.set(
      `m${i}`,
      fakeMessage({ id: `m${i}`, receivedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000), syncCursor: cursor(1000 + i) }),
    );
  }
  const users = new MemoryUsers();
  users.rows.set(USER, {
    googleId: 'g',
    userId: USER,
    email: 'me@example.com',
    scopes: [],
    credentials: { refreshToken: 'r', accessToken: null, accessTokenExpiresAt: null },
    historyId: null,
    lastSyncedAt: null,
  });
  const messages = new MemoryMessages();
  const provider = factory.forAccount({ refreshToken: 'r', accessToken: null, accessTokenExpiresAt: null }, jest.fn());
  const deps = { provider, factory, messages, users, now: () => syncedAt };
  return { deps, box, users, messages };
}

describe('runInitialSync (CONTRACT.md §3.5)', () => {
  it('stores exactly the 50 newest INBOX messages when the inbox holds more', async () => {
    const { deps, messages } = setup(80);
    const result = await runInitialSync(deps, USER);
    expect(INITIAL_SYNC_LIMIT).toBe(50);
    expect(result).toMatchObject({ stored: 50, skipped: 0 });
    const stored = messages.forUser(USER).map((r) => r.gmail_id);
    expect(stored).toHaveLength(50);
    expect(stored).toContain('m79');
    expect(stored).toContain('m30');
    expect(stored).not.toContain('m29');
  });

  it('sets users.history_id from the newest message, with last_synced_at', async () => {
    const { deps, users } = setup(80);
    const result = await runInitialSync(deps, USER);
    expect(result.historyId).toBe('1079');
    expect(users.rows.get(USER)).toMatchObject({ historyId: '1079', lastSyncedAt: syncedAt });
  });

  it('never moves history_id backwards', async () => {
    const { deps, users } = setup(3);
    const row = users.rows.get(USER);
    if (row) {
      row.historyId = '5000';
    }
    await expect(runInitialSync(deps, USER)).resolves.toMatchObject({ historyId: '5000' });
    expect(users.rows.get(USER)?.historyId).toBe('5000');
  });

  it('skips a message deleted between list and get, and removes any stored copy', async () => {
    const { deps, box, messages } = setup(3);
    box.failNext.set('getMessage', new ProviderError('not_found', 'gone'));
    const result = await runInitialSync(deps, USER);
    expect(result).toMatchObject({ stored: 2, skipped: 1, historyId: '1001' });
    expect(messages.deleted).toEqual([[USER, 'm2']]);
  });

  it('propagates other provider failures', async () => {
    const { deps, box } = setup(3);
    box.failNext.set('getMessage', new ProviderError('rate_limited', 'slow down'));
    await expect(runInitialSync(deps, USER)).rejects.toMatchObject({ kind: 'rate_limited' });
  });

  it('leaves history_id null for an empty inbox', async () => {
    const { deps, users } = setup(0);
    await expect(runInitialSync(deps, USER)).resolves.toEqual({ stored: 0, skipped: 0, historyId: null });
    expect(users.rows.get(USER)?.historyId).toBeNull();
  });
});

describe('toMessageRow', () => {
  it('maps to the contract column names, scoped to the user', () => {
    const row = toMessageRow(
      USER,
      fakeMessage({
        id: 'm1',
        labels: ['INBOX', 'STARRED'],
        to: ['a@x.io', 'b@x.io'],
        from: 'Ada <ada@x.io>',
        bodyText: 'plain',
        bodyHtml: '<p>html</p>',
        dateHeader: 'Mon, 6 Oct 2026 09:00:00 +0200',
        syncCursor: cursor(42),
      }),
      syncedAt,
    );
    expect(row).toMatchObject({
      user_id: USER,
      gmail_id: 'm1',
      from_address: 'Ada <ada@x.io>',
      to_address: ['a@x.io', 'b@x.io'],
      body_plain: 'plain',
      body_html: '<p>html</p>',
      date_header: 'Mon, 6 Oct 2026 09:00:00 +0200',
      is_read: true,
      is_starred: true,
      history_id: '42',
      synced_at: syncedAt.toISOString(),
    });
  });
});
