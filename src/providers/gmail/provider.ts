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
} from '../provider';
import {
  type BoundOAuthClient,
  type GmailAuthConfig,
  bindAccount,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  refreshBoundAccessToken,
  verifyRefreshToken,
  watchInbox,
} from './auth';

export const GMAIL_INBOX_LABEL = 'INBOX';
export const GMAIL_UNREAD_LABEL = 'UNREAD';

/** Gmail history IDs are unsigned 64-bit integers with gaps; compare them as BigInt. */
export function compareHistoryIds(a: SyncCursor, b: SyncCursor): -1 | 0 | 1 {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function notYetBuilt(method: string, unit: number): never {
  throw new ProviderError('upstream', `GmailMailProvider.${method} is built in BUILD_SEQUENCE.md unit ${unit}`);
}

export class GmailMailProvider implements MailProvider {
  private readonly bound: BoundOAuthClient;

  constructor(
    private readonly config: GmailAuthConfig,
    credentials: AccountCredentials,
    onTokens: OnTokens,
  ) {
    this.bound = bindAccount(config, credentials, onTokens);
  }

  async listInboxMessageIds(_max: number): Promise<string[]> {
    return notYetBuilt('listInboxMessageIds', 3);
  }

  async getMessage(_id: string): Promise<ProviderMessage> {
    return notYetBuilt('getMessage', 3);
  }

  async listChanges(_since: SyncCursor, _pageToken?: string): Promise<ChangePage> {
    return notYetBuilt('listChanges', 3);
  }

  async sendMessage(_message: OutgoingMessage): Promise<{ id: string; threadId: string }> {
    return notYetBuilt('sendMessage', 5);
  }

  async markRead(_id: string): Promise<{ labels: string[] }> {
    return notYetBuilt('markRead', 6);
  }

  async markUnread(_id: string): Promise<{ labels: string[] }> {
    return notYetBuilt('markUnread', 6);
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
    wellKnownLabels: { inbox: GMAIL_INBOX_LABEL, unread: GMAIL_UNREAD_LABEL },
    forAccount: (credentials: AccountCredentials, onTokens: OnTokens): MailProvider =>
      new GmailMailProvider(config, credentials, onTokens),
    verifyRefreshToken: (refreshToken: string): Promise<VerifiedGrant> => verifyRefreshToken(config, refreshToken),
    compareCursors: compareHistoryIds,
    buildAuthorizationUrl: (options) => buildAuthorizationUrl(config, options),
    exchangeAuthorizationCode: (code: string): Promise<VerifiedGrant> => exchangeAuthorizationCode(config, code),
  };
}
