/**
 * Webhook receiver against the LIVE database (CONTRACT.md §4.5, §3.5): acknowledge first, then
 * fetch the delta from the STORED history_id, never the notification's.
 */
import { ProviderError } from '../../src/providers/provider';
import { fakeMessage } from '../fakes/fakeProvider';
import {
  PUBSUB_TOKEN,
  buildApp,
  createTestUser,
  cursor,
  deleteTestUsers,
  rawMessageRows,
  rawUserRow,
  req,
  seedConnectedUser,
  seedMessages,
} from './support';

jest.setTimeout(60_000);
afterAll(deleteTestUsers);

const push = (emailAddress: string, historyId: string) =>
  req.post(`/api/webhook/gmail?token=${PUBSUB_TOKEN}`, {
    message: { data: Buffer.from(JSON.stringify({ emailAddress, historyId })).toString('base64'), messageId: '1' },
    subscription: 's',
  });

describe('acknowledge-first', () => {
  it('returns 200 before any Gmail call, then syncs in the background', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user, { historyId: '100' });
    app.box.messages.set('new1', fakeMessage({ id: 'new1' }));
    app.box.changePages.set('100', new Map([['', { changes: [{ type: 'messageAdded', messageId: 'new1' }], nextPageToken: null, cursor: cursor(150) }]]));

    // Any provider call made before the response is returned would throw.
    app.box.forbidCalls = true;
    const response = await app.handlers.gmailWebhook(push(user.email, '150'));
    expect(response.status).toBe(200);
    expect(app.box.calls).toEqual([]);
    expect(app.pending).toHaveLength(1);

    // The background sync starts with a DB lookup, so its first provider call comes later.
    app.box.forbidCalls = false;
    await Promise.all(app.pending);
    expect(app.box.calls.map((c) => c.method)).toEqual(['listChanges', 'getMessage']);
    await expect(rawMessageRows(user.userId)).resolves.toHaveLength(1);
  });

  it('acks even when the background sync fails, and leaves history_id unchanged', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user, { historyId: '100' });
    app.box.failNext.set('listChanges', new ProviderError('rate_limited', 'slow'));
    const response = await app.handlers.gmailWebhook(push(user.email, '200'));
    expect(response.status).toBe(200);
    await Promise.all(app.pending);
    await expect(rawUserRow(user.userId)).resolves.toMatchObject({ history_id: '100' });
  });
});

describe('delta fetch from the stored history_id', () => {
  it('lists changes from the stored H, applies them, and saves the history.list cursor', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user, { historyId: '100' });
    const kept = fakeMessage({ id: 'kept1', labels: ['INBOX', 'UNREAD'] });
    await seedMessages(app, user, [kept, fakeMessage({ id: 'gone1' })]);
    app.box.messages.set('added1', fakeMessage({ id: 'added1', labels: ['INBOX', 'STARRED'] }));
    app.box.changePages.set(
      '100',
      new Map([
        ['', { changes: [{ type: 'messageAdded', messageId: 'added1' }], nextPageToken: 'p2', cursor: cursor(240) }],
        [
          'p2',
          {
            changes: [
              { type: 'messageDeleted', messageId: 'gone1' },
              { type: 'labelsRemoved', messageId: 'kept1', labels: ['UNREAD'] },
            ],
            nextPageToken: null,
            cursor: cursor(250),
          },
        ],
      ]),
    );

    await app.handlers.gmailWebhook(push(user.email, '200'));
    await Promise.all(app.pending);

    // Started from the stored 100, not the notification's 200.
    expect(app.box.calls.filter((c) => c.method === 'listChanges').map((c) => c.args[0])).toEqual(['100', '100']);
    const rows = new Map((await rawMessageRows(user.userId)).map((r) => [String(r.gmail_id), r]));
    expect([...rows.keys()].sort()).toEqual(['added1', 'kept1']);
    expect(rows.get('kept1')).toMatchObject({ is_read: true, label_ids: ['INBOX'] });
    expect(rows.get('added1')).toMatchObject({ is_starred: true });
    // Saved from the last history.list page (250), not the notification (200).
    await expect(rawUserRow(user.userId)).resolves.toMatchObject({ history_id: '250' });
  });

  it('ignores a replayed notification (historyId <= stored) with zero Gmail calls', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user, { historyId: '300' });
    app.box.forbidCalls = true;
    for (const id of ['300', '299']) {
      await app.handlers.gmailWebhook(push(user.email, id));
    }
    await Promise.all(app.pending);
    expect(app.box.calls).toEqual([]);
    await expect(rawUserRow(user.userId)).resolves.toMatchObject({ history_id: '300' });
  });

  it('falls back to a full sync when the stored history_id has expired', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user, { historyId: '100' });
    app.box.expiredBefore = cursor(100);
    app.box.messages.set('full1', fakeMessage({ id: 'full1', syncCursor: cursor(900) }));
    await app.handlers.gmailWebhook(push(user.email, '500'));
    await Promise.all(app.pending);
    expect(app.box.calls.map((c) => c.method)).toEqual(['listChanges', 'listInboxMessageIds', 'getMessage']);
    await expect(rawUserRow(user.userId)).resolves.toMatchObject({ history_id: '900' });
  });

  it('clears stored tokens when the grant is revoked', async () => {
    const user = await createTestUser();
    const app = buildApp();
    await seedConnectedUser(app, user, { historyId: '100' });
    app.box.failNext.set('listChanges', new ProviderError('revoked', 'invalid_grant'));
    await app.handlers.gmailWebhook(push(user.email, '200'));
    await Promise.all(app.pending);
    await expect(rawUserRow(user.userId)).resolves.toMatchObject({ refresh_token: null, access_token: null });
  });
});
