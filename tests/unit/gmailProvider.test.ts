import type { GmailAuthConfig } from '../../src/providers/gmail/auth';
import { GmailMailProvider } from '../../src/providers/gmail/provider';
import { cursor } from '../fakes/fakeProvider';

const config: GmailAuthConfig = {
  clientId: 'c',
  clientSecret: 's',
  redirectUri: 'http://localhost:3000/cb',
  pubsubTopic: 'projects/p/topics/t',
};
const creds = { refreshToken: 'r', accessToken: 'a', accessTokenExpiresAt: new Date(Date.now() + 3600_000) };

interface RequestOptions {
  url: string;
  params?: Record<string, unknown>;
}

function providerWith(respond: (options: RequestOptions) => unknown) {
  const provider = new GmailMailProvider(config, creds, jest.fn());
  const client = (provider as unknown as { bound: { client: { request: (o: RequestOptions) => Promise<unknown> } } })
    .bound.client;
  const calls: RequestOptions[] = [];
  jest.spyOn(client, 'request').mockImplementation(async (options: RequestOptions) => {
    calls.push(options);
    return respond(options);
  });
  return { provider, calls };
}

const ids = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `m${from + i}`, threadId: `t${from + i}` }));

afterEach(() => jest.restoreAllMocks());

describe('GmailMailProvider.listInboxMessageIds', () => {
  it('pages with pageToken and stops at max', async () => {
    const { provider, calls } = providerWith((o) => ({
      data: o.params?.pageToken
        ? { messages: ids(30, 30), nextPageToken: 'p3' }
        : { messages: ids(0, 30), nextPageToken: 'p2' },
    }));
    const result = await provider.listInboxMessageIds(50);
    expect(result).toHaveLength(50);
    expect(result[0]).toBe('m0');
    expect(result[49]).toBe('m49');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.params).toMatchObject({ labelIds: ['INBOX'], maxResults: 50 });
    expect(calls[1]?.params).toMatchObject({ labelIds: ['INBOX'], maxResults: 20, pageToken: 'p2' });
  });

  it('stops when the inbox is exhausted', async () => {
    const { provider, calls } = providerWith(() => ({ data: { messages: ids(0, 3) } }));
    await expect(provider.listInboxMessageIds(50)).resolves.toEqual(['m0', 'm1', 'm2']);
    expect(calls).toHaveLength(1);
  });

  it('handles an empty inbox', async () => {
    const { provider } = providerWith(() => ({ data: { resultSizeEstimate: 0 } }));
    await expect(provider.listInboxMessageIds(50)).resolves.toEqual([]);
  });
});

describe('GmailMailProvider.getMessage', () => {
  it('requests format=full and parses the result', async () => {
    const { provider, calls } = providerWith(() => ({
      data: { id: 'm1', threadId: 't1', historyId: '9', internalDate: '0', labelIds: ['INBOX'] },
    }));
    await expect(provider.getMessage('m1')).resolves.toMatchObject({ id: 'm1', syncCursor: '9', inInbox: true });
    expect(calls[0]?.url).toContain('/gmail/v1/users/me/messages/m1');
    expect(calls[0]?.params).toMatchObject({ format: 'full' });
  });

  it('maps a 404 to not_found', async () => {
    const { provider } = providerWith(() => {
      throw { response: { status: 404 } };
    });
    await expect(provider.getMessage('gone')).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('GmailMailProvider.listChanges', () => {
  it('requests history from the given cursor and maps records to ordered changes', async () => {
    const { provider, calls } = providerWith(() => ({
      data: {
        historyId: '250',
        nextPageToken: 'n2',
        history: [
          { id: '201', messagesAdded: [{ message: { id: 'a', threadId: 't' } }] },
          { id: '202', messagesDeleted: [{ message: { id: 'b' } }] },
          { id: '203', labelsAdded: [{ message: { id: 'c' }, labelIds: ['STARRED'] }] },
          { id: '204', labelsRemoved: [{ message: { id: 'c' }, labelIds: ['UNREAD'] }] },
        ],
      },
    }));
    const page = await provider.listChanges(cursor('200'), 'p1');
    expect(page).toEqual({
      changes: [
        { type: 'messageAdded', messageId: 'a' },
        { type: 'messageDeleted', messageId: 'b' },
        { type: 'labelsAdded', messageId: 'c', labels: ['STARRED'] },
        { type: 'labelsRemoved', messageId: 'c', labels: ['UNREAD'] },
      ],
      nextPageToken: 'n2',
      cursor: '250',
    });
    expect(calls[0]?.url).toContain('/gmail/v1/users/me/history');
    expect(calls[0]?.params).toMatchObject({
      startHistoryId: '200',
      pageToken: 'p1',
      historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
    });
  });

  it('maps a 404 to cursor_expired', async () => {
    const { provider } = providerWith(() => {
      throw { response: { status: 404 } };
    });
    await expect(provider.listChanges(cursor('1'))).rejects.toMatchObject({ kind: 'cursor_expired' });
  });
});

describe('GmailMailProvider.sendMessage', () => {
  it('sends base64url RFC 2822 with threadId passed through', async () => {
    const { provider, calls } = providerWith(() => ({ data: { id: 's1', threadId: 'T9', labelIds: ['SENT'] } }));
    const result = await provider.sendMessage({
      from: 'me@example.com',
      to: ['you@example.com'],
      subject: 'Hi',
      text: 'Hello',
      threadId: 'T9',
    });
    expect(result).toEqual({ id: 's1', threadId: 'T9' });
    const call = calls[0] as RequestOptions & { data?: { raw: string; threadId?: string } };
    expect(call.url).toContain('/gmail/v1/users/me/messages/send');
    expect(call.data?.threadId).toBe('T9');
    const mime = Buffer.from(call.data?.raw ?? '', 'base64url').toString('utf8');
    expect(mime).toContain('From: me@example.com\r\n');
    expect(mime).toContain('To: you@example.com\r\n');
    expect(mime).toContain('Subject: Hi\r\n');
    expect(mime).not.toContain('In-Reply-To');
  });

  it('maps a 404 to not_found', async () => {
    const { provider } = providerWith(() => {
      throw { response: { status: 404 } };
    });
    await expect(
      provider.sendMessage({ from: 'a@x.io', to: ['b@x.io'], subject: 's', text: 't', threadId: 'nope' }),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('GmailMailProvider.markRead / markUnread', () => {
  it('removes or adds UNREAD with messages.modify and returns the labels', async () => {
    const { provider, calls } = providerWith((o) => ({
      data: { id: 'm1', labelIds: o.url.endsWith('/modify') && calls.length === 1 ? ['INBOX'] : ['INBOX', 'UNREAD'] },
    }));
    await expect(provider.markRead('m1')).resolves.toEqual({ labels: ['INBOX'] });
    await expect(provider.markUnread('m1')).resolves.toEqual({ labels: ['INBOX', 'UNREAD'] });
    const bodies = calls.map((c) => (c as RequestOptions & { data?: unknown }).data);
    expect(calls[0]?.url).toContain('/gmail/v1/users/me/messages/m1/modify');
    expect(bodies).toEqual([{ removeLabelIds: ['UNREAD'] }, { addLabelIds: ['UNREAD'] }]);
  });
});
