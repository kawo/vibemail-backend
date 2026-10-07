import {
  type MailProvider,
  type OutgoingMessage,
  type ProviderChange,
  type SyncCursor,
  ProviderError,
} from '../../src/providers/provider';
import { createFakeProviderFactory, cursor, fakeMessage } from '../fakes/fakeProvider';

const credentials = { refreshToken: 'r', accessToken: null, accessTokenExpiresAt: null };
const noop = async (): Promise<void> => {};

describe('ProviderError', () => {
  it('keeps kind, retryAfterSeconds and cause', () => {
    const cause = new Error('429');
    const error = new ProviderError('rate_limited', 'slow down', { retryAfterSeconds: 30, cause });

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ProviderError');
    expect(error.kind).toBe('rate_limited');
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.cause).toBe(cause);
  });

  it('omits retryAfterSeconds when not given', () => {
    expect(new ProviderError('revoked', 'gone').retryAfterSeconds).toBeUndefined();
  });
});

describe('fake provider conforms to MailProvider', () => {
  function setup() {
    const { factory, box } = createFakeProviderFactory();
    box.messages.set('old', fakeMessage({ id: 'old', receivedAt: new Date('2026-01-01') }));
    box.messages.set('new', fakeMessage({ id: 'new', receivedAt: new Date('2026-02-01') }));
    const provider: MailProvider = factory.forAccount(credentials, noop);
    return { factory, box, provider };
  }

  it('lists inbox ids newest first, capped at max', async () => {
    const { provider } = setup();
    await expect(provider.listInboxMessageIds(1)).resolves.toEqual(['new']);
  });

  it('rejects getMessage for a missing message with not_found', async () => {
    const { provider } = setup();
    await expect(provider.getMessage('missing')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('marks read and unread idempotently and returns labels', async () => {
    const { provider, box } = setup();
    await provider.markRead('new');
    await expect(provider.markRead('new')).resolves.toEqual({ labels: ['INBOX'] });
    expect(box.messages.get('new')?.isRead).toBe(true);
    await expect(provider.markUnread('new')).resolves.toEqual({ labels: ['INBOX', 'UNREAD'] });
  });

  it('rejects listChanges with cursor_expired for a cursor outside history', async () => {
    const { provider, box } = setup();
    box.expiredBefore = cursor(10);
    await expect(provider.listChanges(cursor(5))).rejects.toMatchObject({ kind: 'cursor_expired' });
    await expect(provider.listChanges(cursor(11))).resolves.toMatchObject({ nextPageToken: null });
  });

  it('reports refreshed tokens through onTokens', async () => {
    const { factory } = createFakeProviderFactory();
    const updates: unknown[] = [];
    const provider = factory.forAccount(credentials, async (update) => {
      updates.push(update);
    });
    const update = await provider.refreshAccessToken();
    expect(updates).toEqual([update]);
  });

  it('replays scripted failures once', async () => {
    const { provider, box } = setup();
    box.failNext.set('watch', new ProviderError('revoked', 'invalid_grant'));
    await expect(provider.watch()).rejects.toMatchObject({ kind: 'revoked' });
    await expect(provider.watch()).resolves.toHaveProperty('expiresAt');
  });

  it('rejects every call when calls are forbidden', async () => {
    const { provider, box } = setup();
    box.forbidCalls = true;
    await expect(provider.getMessage('new')).rejects.toBeInstanceOf(ProviderError);
    expect(box.calls).toEqual([]);
  });

  it('orders cursors through the factory', () => {
    const { factory } = setup();
    expect(factory.compareCursors(cursor(2), cursor(10))).toBe(-1);
    expect(factory.compareCursors(cursor(10), cursor(10))).toBe(0);
    expect(factory.compareCursors(cursor(11), cursor(10))).toBe(1);
  });
});

describe('type-level guarantees', () => {
  it('keeps SyncCursor opaque', () => {
    // @ts-expect-error a plain string is not a SyncCursor
    const bad: SyncCursor = '123';
    expect(bad).toBe('123');
  });

  it('narrows ProviderChange on type', () => {
    const change: ProviderChange = { type: 'labelsAdded', messageId: 'm', labels: ['INBOX'] };
    const labels = change.type === 'labelsAdded' ? change.labels : [];
    expect(labels).toEqual(['INBOX']);

    // @ts-expect-error messageDeleted carries no labels
    const deleted: ProviderChange = { type: 'messageDeleted', messageId: 'm', labels: [] };
    expect(deleted.type).toBe('messageDeleted');
  });

  it('rejects unknown OutgoingMessage fields', () => {
    const message: OutgoingMessage = {
      from: 'me@example.com',
      to: ['you@example.com'],
      subject: 'Hi',
      // @ts-expect-error raw MIME is not part of the provider-agnostic contract
      raw: 'base64',
    };
    expect(message.subject).toBe('Hi');
  });
});
