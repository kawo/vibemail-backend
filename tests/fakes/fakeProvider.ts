import {
  type AccountCredentials,
  type ChangePage,
  type MailProvider,
  type MailProviderFactory,
  type OnTokens,
  type OutgoingMessage,
  type ProviderMessage,
  type SyncCursor,
  type TokenUpdate,
  type VerifiedGrant,
  type WatchResult,
  ProviderError,
} from '../../src/providers/provider';

export const FAKE_INBOX = 'INBOX';
export const FAKE_UNREAD = 'UNREAD';

export const cursor = (value: number | string): SyncCursor => String(value) as SyncCursor;

export type FakeCall = { method: keyof MailProvider; args: unknown[] };

/** Mutable in-memory mailbox shared by the factory and its providers. */
export interface FakeMailbox {
  messages: Map<string, ProviderMessage>;
  /** Pages returned by `listChanges`, keyed by `since` cursor, then by page token ('' for the first page). */
  changePages: Map<string, Map<string, ChangePage>>;
  /** Cursors older than or equal to this make `listChanges` reject with `cursor_expired`. */
  expiredBefore: SyncCursor | null;
  currentCursor: SyncCursor;
  sent: OutgoingMessage[];
  calls: FakeCall[];
  /** Scripted failures: the next call to the method rejects with this error, then the entry is removed. */
  failNext: Map<keyof MailProvider, ProviderError>;
  /** When true, any provider call rejects. Used to assert "makes zero provider calls". */
  forbidCalls: boolean;
}

export function createFakeMailbox(): FakeMailbox {
  return {
    messages: new Map(),
    changePages: new Map(),
    expiredBefore: null,
    currentCursor: cursor(1),
    sent: [],
    calls: [],
    failNext: new Map(),
    forbidCalls: false,
  };
}

export function fakeMessage(overrides: Partial<ProviderMessage> & { id: string }): ProviderMessage {
  const labels = overrides.labels ?? [FAKE_INBOX, FAKE_UNREAD];
  return {
    threadId: overrides.id,
    labels,
    isRead: !labels.includes(FAKE_UNREAD),
    inInbox: labels.includes(FAKE_INBOX),
    receivedAt: new Date('2026-10-01T12:00:00.000Z'),
    sizeBytes: 1024,
    snippet: '',
    subject: 'Subject',
    from: 'Sender <sender@example.com>',
    to: ['me@example.com'],
    cc: [],
    bcc: [],
    rfc822MessageId: `<${overrides.id}@example.com>`,
    inReplyTo: null,
    references: null,
    dateHeader: null,
    bodyText: 'Body',
    bodyHtml: null,
    attachments: [],
    syncCursor: cursor(1),
    ...overrides,
  };
}

function compare(a: SyncCursor, b: SyncCursor): -1 | 0 | 1 {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

class FakeMailProvider implements MailProvider {
  constructor(
    private readonly box: FakeMailbox,
    private readonly onTokens: OnTokens,
  ) {}

  private record(method: keyof MailProvider, args: unknown[]): void {
    if (this.box.forbidCalls) {
      throw new ProviderError('upstream', `unexpected provider call: ${method}`);
    }
    this.box.calls.push({ method, args });
    const failure = this.box.failNext.get(method);
    if (failure) {
      this.box.failNext.delete(method);
      throw failure;
    }
  }

  private setLabels(id: string, add: string[], remove: string[]): { labels: string[] } {
    const message = this.box.messages.get(id);
    if (!message) {
      throw new ProviderError('not_found', `message ${id} not found`);
    }
    const labels = [...new Set([...message.labels, ...add])].filter((l) => !remove.includes(l));
    this.box.messages.set(id, {
      ...message,
      labels,
      isRead: !labels.includes(FAKE_UNREAD),
      inInbox: labels.includes(FAKE_INBOX),
    });
    return { labels };
  }

  async listInboxMessageIds(max: number): Promise<string[]> {
    this.record('listInboxMessageIds', [max]);
    return [...this.box.messages.values()]
      .filter((m) => m.inInbox)
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, max)
      .map((m) => m.id);
  }

  async getMessage(id: string): Promise<ProviderMessage> {
    this.record('getMessage', [id]);
    const message = this.box.messages.get(id);
    if (!message) {
      throw new ProviderError('not_found', `message ${id} not found`);
    }
    return message;
  }

  async listChanges(since: SyncCursor, pageToken?: string): Promise<ChangePage> {
    this.record('listChanges', [since, pageToken]);
    if (this.box.expiredBefore !== null && compare(since, this.box.expiredBefore) <= 0) {
      throw new ProviderError('cursor_expired', `cursor ${since} is outside retained history`);
    }
    const page = this.box.changePages.get(since)?.get(pageToken ?? '');
    return page ?? { changes: [], nextPageToken: null, cursor: this.box.currentCursor };
  }

  async sendMessage(message: OutgoingMessage): Promise<{ id: string; threadId: string }> {
    this.record('sendMessage', [message]);
    this.box.sent.push(message);
    const id = `sent-${this.box.sent.length}`;
    const threadId = message.threadId ?? id;
    this.box.messages.set(
      id,
      fakeMessage({
        id,
        threadId,
        labels: ['SENT'],
        subject: message.subject,
        from: message.from,
        to: message.to,
        cc: message.cc ?? [],
        bcc: message.bcc ?? [],
        inReplyTo: message.inReplyTo ?? null,
        references: message.references ?? null,
        bodyText: message.text ?? null,
        bodyHtml: message.html ?? null,
      }),
    );
    return { id, threadId };
  }

  async markRead(id: string): Promise<{ labels: string[] }> {
    this.record('markRead', [id]);
    return this.setLabels(id, [], [FAKE_UNREAD]);
  }

  async markUnread(id: string): Promise<{ labels: string[] }> {
    this.record('markUnread', [id]);
    return this.setLabels(id, [FAKE_UNREAD], []);
  }

  async watch(): Promise<WatchResult> {
    this.record('watch', []);
    return { cursor: this.box.currentCursor, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) };
  }

  async refreshAccessToken(): Promise<TokenUpdate> {
    this.record('refreshAccessToken', []);
    const update: TokenUpdate = {
      accessToken: `access-${this.box.calls.length}`,
      accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
    };
    await this.onTokens(update);
    return update;
  }
}

export interface FakeFactoryOptions {
  /** Grant returned by `verifyRefreshToken`; defaults to a valid grant with all v1 scopes. */
  grant?: VerifiedGrant;
}

/** In-memory `MailProviderFactory` for tests. Every provider it creates shares `box`. */
export function createFakeProviderFactory(
  box: FakeMailbox = createFakeMailbox(),
  options: FakeFactoryOptions = {},
) {
  const factory = {
    providerId: 'fake',
    wellKnownLabels: { inbox: FAKE_INBOX, unread: FAKE_UNREAD },
    forAccount(_credentials: AccountCredentials, onTokens: OnTokens): MailProvider {
      return new FakeMailProvider(box, onTokens);
    },
    async verifyRefreshToken(refreshToken: string): Promise<VerifiedGrant> {
      if (options.grant) {
        return options.grant;
      }
      return {
        email: 'me@example.com',
        scopes: ['gmail.modify', 'gmail.send', 'email'],
        credentials: {
          refreshToken,
          accessToken: 'access-0',
          accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
        },
      };
    },
    compareCursors: compare,
    buildAuthorizationUrl({ state }: { state: string; scopes: string[]; loginHint?: string }): string {
      return `https://auth.example.com/?state=${encodeURIComponent(state)}`;
    },
    async exchangeAuthorizationCode(code: string): Promise<VerifiedGrant> {
      return factory.verifyRefreshToken(`refresh-for-${code}`);
    },
  } satisfies MailProviderFactory;
  return { factory, box };
}
