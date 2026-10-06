import type { ChangePage, ProviderChange } from '../../src/providers/provider';
import { ProviderError } from '../../src/providers/provider';
import { applyLabelDelta, runIncrementalSync, toMessageRow } from '../../src/sync';
import { createFakeProviderFactory, cursor, fakeMessage } from '../fakes/fakeProvider';
import { MemoryMessages, MemoryUsers } from '../fakes/memoryRepos';

const USER = 'user-1';
const at = new Date('2026-10-06T10:00:00.000Z');

function setup() {
  const { factory, box } = createFakeProviderFactory();
  const users = new MemoryUsers();
  users.rows.set(USER, {
    googleId: 'g',
    userId: USER,
    email: 'me@example.com',
    scopes: [],
    credentials: { refreshToken: 'r', accessToken: null, accessTokenExpiresAt: null },
    historyId: '100',
    lastSyncedAt: null,
  });
  const messages = new MemoryMessages();
  const provider = factory.forAccount({ refreshToken: 'r', accessToken: null, accessTokenExpiresAt: null }, jest.fn());
  const pages = (list: Array<[string, ChangePage]>) => box.changePages.set('100', new Map(list));
  const store = (id: string, labels: string[]) =>
    messages.upsertMessages(USER, [toMessageRow(USER, fakeMessage({ id, labels }), at)]);
  return { deps: { provider, factory, messages, users, now: () => at }, box, users, messages, pages, store };
}

describe('runIncrementalSync (CONTRACT.md §3.5)', () => {
  it('applies exactly the recorded changes, across pages, then saves the last cursor', async () => {
    const { deps, box, users, messages, pages, store } = setup();
    await store('old', ['INBOX', 'UNREAD']);
    await store('gone', ['INBOX']);
    box.messages.set('new', fakeMessage({ id: 'new', labels: ['INBOX'] }));
    pages([
      ['', { changes: [{ type: 'messageAdded', messageId: 'new' }], nextPageToken: 'p2', cursor: cursor(150) }],
      [
        'p2',
        {
          changes: [
            { type: 'messageDeleted', messageId: 'gone' },
            { type: 'labelsRemoved', messageId: 'old', labels: ['UNREAD'] },
            { type: 'labelsAdded', messageId: 'old', labels: ['STARRED'] },
          ],
          nextPageToken: null,
          cursor: cursor(200),
        },
      ],
    ]);

    const result = await runIncrementalSync(deps, USER, cursor(100));

    expect(result).toEqual({ applied: 4, skipped: 0, historyId: '200' });
    expect(box.calls.filter((c) => c.method === 'listInboxMessageIds')).toEqual([]);
    const byId = new Map(messages.forUser(USER).map((r) => [r.gmail_id, r]));
    expect([...byId.keys()].sort()).toEqual(['new', 'old']);
    expect(byId.get('old')).toMatchObject({ label_ids: ['INBOX', 'STARRED'], is_read: true, is_starred: true });
    expect(users.rows.get(USER)).toMatchObject({ historyId: '200', lastSyncedAt: at });
  });

  it('skips a message added then deleted before the sync fetched it', async () => {
    const { deps, messages, pages } = setup();
    pages([['', { changes: [{ type: 'messageAdded', messageId: 'vanished' }], nextPageToken: null, cursor: cursor(120) }]]);
    await expect(runIncrementalSync(deps, USER, cursor(100))).resolves.toMatchObject({ applied: 0, skipped: 1 });
    expect(messages.deleted).toEqual([[USER, 'vanished']]);
  });

  it('fetches and stores a message that gains INBOX but is not stored yet', async () => {
    const { deps, box, messages, pages } = setup();
    box.messages.set('archived', fakeMessage({ id: 'archived', labels: ['INBOX', 'IMPORTANT'] }));
    pages([
      ['', { changes: [{ type: 'labelsAdded', messageId: 'archived', labels: ['INBOX'] }], nextPageToken: null, cursor: cursor(130) }],
    ]);
    await runIncrementalSync(deps, USER, cursor(100));
    expect(box.calls.filter((c) => c.method === 'getMessage')).toHaveLength(1);
    expect(messages.forUser(USER)[0]?.label_ids).toEqual(['INBOX', 'IMPORTANT']);
  });

  it('does not save the cursor when a change fails', async () => {
    const { deps, box, users, pages } = setup();
    box.messages.set('new', fakeMessage({ id: 'new' }));
    box.failNext.set('getMessage', new ProviderError('rate_limited', 'slow'));
    pages([['', { changes: [{ type: 'messageAdded', messageId: 'new' }], nextPageToken: null, cursor: cursor(150) }]]);
    await expect(runIncrementalSync(deps, USER, cursor(100))).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(users.rows.get(USER)?.historyId).toBe('100');
  });

  it('rejects with cursor_expired for a too-old cursor', async () => {
    const { deps, box } = setup();
    box.expiredBefore = cursor(100);
    await expect(runIncrementalSync(deps, USER, cursor(100))).rejects.toMatchObject({ kind: 'cursor_expired' });
  });
});

describe('applyLabelDelta', () => {
  const added: ProviderChange = { type: 'labelsAdded', messageId: 'm', labels: ['B', 'C'] };
  const removed: ProviderChange = { type: 'labelsRemoved', messageId: 'm', labels: ['A', 'Z'] };
  it('adds without duplicates and removes absent labels safely', () => {
    expect(applyLabelDelta(['A', 'B'], added)).toEqual(['A', 'B', 'C']);
    expect(applyLabelDelta(['A', 'B'], removed)).toEqual(['B']);
  });
});
