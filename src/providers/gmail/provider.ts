import {
  type AccountCredentials,
  type ChangePage,
  type MailProvider,
  type MailProviderFactory,
  type OnTokens,
  type OutgoingMessage,
  type ProviderChange,
  type ProviderMessage,
  type SyncCursor,
  type TokenUpdate,
  type VerifiedGrant,
  type WatchResult,
  ProviderError,
} from '../provider';
import {
  type BoundOAuthClient,
  type GmailAuthConfig,
  bindAccount,
  buildAuthorizationUrl,
  toProviderError,
  exchangeAuthorizationCode,
  refreshBoundAccessToken,
  verifyRefreshToken,
  watchInbox,
} from './auth';
import { google, type gmail_v1 } from 'googleapis';
import { parseGmailMessage } from './messages';
import { buildRfc2822, toRaw } from './mime';

export const GMAIL_INBOX_LABEL = 'INBOX';
export const GMAIL_UNREAD_LABEL = 'UNREAD';
export const GMAIL_STARRED_LABEL = 'STARRED';

/** Gmail history IDs are unsigned 64-bit integers with gaps; compare them as BigInt. */
export function compareHistoryIds(a: SyncCursor, b: SyncCursor): -1 | 0 | 1 {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Flattens one Gmail history record into ordered changes. Records carry only IDs and label deltas. */
export function historyToChanges(record: gmail_v1.Schema$History): ProviderChange[] {
  const changes: ProviderChange[] = [];
  for (const added of record.messagesAdded ?? []) {
    if (added.message?.id) {
      changes.push({ type: 'messageAdded', messageId: added.message.id });
    }
  }
  for (const deleted of record.messagesDeleted ?? []) {
    if (deleted.message?.id) {
      changes.push({ type: 'messageDeleted', messageId: deleted.message.id });
    }
  }
  for (const added of record.labelsAdded ?? []) {
    if (added.message?.id) {
      changes.push({ type: 'labelsAdded', messageId: added.message.id, labels: added.labelIds ?? [] });
    }
  }
  for (const removed of record.labelsRemoved ?? []) {
    if (removed.message?.id) {
      changes.push({ type: 'labelsRemoved', messageId: removed.message.id, labels: removed.labelIds ?? [] });
    }
  }
  return changes;
}

/** Gmail caps `maxResults` for `messages.list` at 500. */
const LIST_PAGE_MAX = 500;

export class GmailMailProvider implements MailProvider {
  private readonly bound: BoundOAuthClient;
  private readonly gmail: gmail_v1.Gmail;

  constructor(
    private readonly config: GmailAuthConfig,
    credentials: AccountCredentials,
    onTokens: OnTokens,
  ) {
    this.bound = bindAccount(config, credentials, onTokens);
    this.gmail = google.gmail({ version: 'v1', auth: this.bound.client });
  }

  /** Runs a Gmail call, then waits for any token refresh it caused to be persisted. */
  private async call<T>(context: string, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      await this.bound.pendingWrites();
      return result;
    } catch (error) {
      throw toProviderError(error, context);
    }
  }

  /** Newest-first INBOX IDs, paging with `pageToken` until `max` IDs are collected or the inbox is exhausted. */
  async listInboxMessageIds(max: number): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const { data } = await this.call('messages.list', () =>
        this.gmail.users.messages.list({
          userId: 'me',
          labelIds: ['INBOX'],
          maxResults: Math.min(max - ids.length, LIST_PAGE_MAX),
          ...(pageToken ? { pageToken } : {}),
        }),
      );
      for (const message of data.messages ?? []) {
        if (message.id && ids.length < max) {
          ids.push(message.id);
        }
      }
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken && ids.length < max);
    return ids;
  }

  async getMessage(id: string): Promise<ProviderMessage> {
    const { data } = await this.call('messages.get', () =>
      this.gmail.users.messages.get({ userId: 'me', id, format: 'full' }),
    );
    return parseGmailMessage(data);
  }

  /** One page of `history.list` since `since`. A 404 means the cursor is too old: `cursor_expired`. */
  async listChanges(since: SyncCursor, pageToken?: string): Promise<ChangePage> {
    let data: gmail_v1.Schema$ListHistoryResponse;
    try {
      ({ data } = await this.call('history.list', () =>
        this.gmail.users.history.list({
          userId: 'me',
          startHistoryId: since,
          historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
          ...(pageToken ? { pageToken } : {}),
        }),
      ));
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not_found') {
        throw new ProviderError('cursor_expired', `history ${since} is outside the retained window`, {
          cause: error,
        });
      }
      throw error;
    }
    if (!data.historyId) {
      throw new ProviderError('upstream', 'history.list response lacks historyId');
    }
    return {
      changes: (data.history ?? []).flatMap(historyToChanges),
      nextPageToken: data.nextPageToken ?? null,
      cursor: data.historyId as SyncCursor,
    };
  }

  /** Builds RFC 2822 MIME and sends it; `threadId` is passed to Gmail unchanged (CONTRACT.md §4.3). */
  async sendMessage(message: OutgoingMessage): Promise<{ id: string; threadId: string }> {
    const { data } = await this.call('messages.send', () =>
      this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: toRaw(buildRfc2822(message)),
          ...(message.threadId ? { threadId: message.threadId } : {}),
        },
      }),
    );
    if (!data.id || !data.threadId) {
      throw new ProviderError('upstream', 'messages.send response lacks id or threadId');
    }
    return { id: data.id, threadId: data.threadId };
  }

  /** `messages.modify`; idempotent in Gmail. Returns the message's labels afterwards. */
  private async modifyLabels(
    id: string,
    change: { addLabelIds?: string[]; removeLabelIds?: string[] },
  ): Promise<{ labels: string[] }> {
    const { data } = await this.call('messages.modify', () =>
      this.gmail.users.messages.modify({ userId: 'me', id, requestBody: change }),
    );
    return { labels: data.labelIds ?? [] };
  }

  async markRead(id: string): Promise<{ labels: string[] }> {
    return this.modifyLabels(id, { removeLabelIds: [GMAIL_UNREAD_LABEL] });
  }

  async markUnread(id: string): Promise<{ labels: string[] }> {
    return this.modifyLabels(id, { addLabelIds: [GMAIL_UNREAD_LABEL] });
  }

  async watch(): Promise<WatchResult> {
    return watchInbox(this.config, this.bound);
  }

  async refreshAccessToken(): Promise<TokenUpdate> {
    return refreshBoundAccessToken(this.bound);
  }
}

export function createGmailProviderFactory(config: GmailAuthConfig): MailProviderFactory {
  return {
    providerId: 'gmail',
    wellKnownLabels: { inbox: GMAIL_INBOX_LABEL, unread: GMAIL_UNREAD_LABEL, starred: GMAIL_STARRED_LABEL },
    forAccount: (credentials: AccountCredentials, onTokens: OnTokens): MailProvider =>
      new GmailMailProvider(config, credentials, onTokens),
    verifyRefreshToken: (refreshToken: string): Promise<VerifiedGrant> => verifyRefreshToken(config, refreshToken),
    compareCursors: compareHistoryIds,
    buildAuthorizationUrl: (options) => buildAuthorizationUrl(config, options),
    exchangeAuthorizationCode: (code: string): Promise<VerifiedGrant> => exchangeAuthorizationCode(config, code),
  };
}
