import type { GmailAuthConfig } from '../../src/providers/gmail/auth';
import { GmailMailProvider } from '../../src/providers/gmail/provider';

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
