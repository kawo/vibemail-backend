/**
 * Provider-agnostic mail provider contract (BUILD_SEQUENCE.md unit 1).
 *
 * Every email backend (Gmail today) implements `MailProviderFactory` and
 * `MailProvider`. Nothing in this file may reference a provider SDK: callers in
 * sync, send, webhook and api code depend only on these types.
 */

/** Opaque sync position. Only the issuing provider can interpret or order it. */
export type SyncCursor = string & { readonly __brand: 'SyncCursor' };

export type ProviderErrorKind =
  /** The grant is revoked or invalid; the user must reconnect. Maps to GMAIL_TOKEN_REVOKED. */
  | 'revoked'
  /** The provider throttled the call. Maps to GMAIL_RATE_LIMITED. */
  | 'rate_limited'
  /** The message no longer exists at the provider. */
  | 'not_found'
  /** The sync cursor is outside the provider's retained history; run a full sync (CONTRACT.md §3.5). */
  | 'cursor_expired'
  /** Any other provider failure. Maps to GMAIL_UPSTREAM_ERROR or SYNC_FAILED. */
  | 'upstream';

/** The only error a provider method may reject with. Implementations translate their SDK errors into it. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAfterSeconds?: number;
  /** The underlying SDK error. Declared here because the project targets ES2020, which lacks `Error.cause`. */
  readonly cause?: unknown;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

/** Stored credentials for one mailbox (decrypted; see CONTRACT.md §5.4). */
export interface AccountCredentials {
  refreshToken: string;
  /** Always paired with `accessTokenExpiresAt`: both set or both null (CONTRACT.md §3.1). */
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
}

/** Emitted on every token refresh, for persistence. */
export interface TokenUpdate {
  accessToken: string;
  accessTokenExpiresAt: Date;
  /** Present only when the provider rotated the refresh token. */
  refreshToken?: string;
}

/** Persistence hook called by a provider after every refresh. */
export type OnTokens = (update: TokenUpdate) => Promise<void>;

/** Result of proving a grant: identity, granted scopes and fresh credentials. */
export interface VerifiedGrant {
  /** The provider's stable account ID (Gmail: token-info `sub`, stored as `google_id`), or null if not disclosed. */
  accountId: string | null;
  /** The account's email, or null if the email scope was not granted. */
  email: string | null;
  /** The account's display name, or null if the profile scope was not granted. */
  name: string | null;
  scopes: string[];
  credentials: AccountCredentials;
}

export interface AttachmentMeta {
  partId: string;
  filename: string;
  mimeType: string;
  /** Size in bytes. */
  size: number;
  attachmentId: string;
}

/** A fully parsed message. Covers every source field of CONTRACT.md §5.1. */
export interface ProviderMessage {
  id: string;
  threadId: string;
  /** The provider's own label or folder IDs. */
  labels: string[];
  isRead: boolean;
  isStarred: boolean;
  inInbox: boolean;
  receivedAt: Date;
  sizeBytes: number;
  snippet: string;
  subject: string | null;
  /** Raw header value, e.g. `Ada <ada@x.io>`. */
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  rfc822MessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  /** Raw, unparsed `Date` header. */
  dateHeader: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: AttachmentMeta[];
  /** The provider's sync position as of this message's last change. */
  syncCursor: SyncCursor;
}

/** A message to send. The implementation builds the wire format (e.g. RFC 2822 MIME). */
export interface OutgoingMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** At least one of `text` / `html` is required (validated by the caller, CONTRACT.md §4.3). */
  text?: string;
  html?: string;
  /** Set when replying, to keep the message in the original thread. */
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

/** One mailbox change since a cursor. Label changes are deltas, not full label sets. */
export type ProviderChange =
  | { type: 'messageAdded'; messageId: string }
  | { type: 'messageDeleted'; messageId: string }
  | { type: 'labelsAdded'; messageId: string; labels: string[] }
  | { type: 'labelsRemoved'; messageId: string; labels: string[] };

export interface ChangePage {
  changes: ProviderChange[];
  /** Null on the last page. */
  nextPageToken: string | null;
  /** The mailbox's current position; store it once `nextPageToken` is null. */
  cursor: SyncCursor;
}

export interface WatchResult {
  cursor: SyncCursor;
  /** When push notifications stop unless `watch()` is called again. */
  expiresAt: Date;
}

/** A provider bound to one mailbox. Every method rejects only with `ProviderError`. */
export interface MailProvider {
  /** IDs of the newest inbox messages, newest first, at most `max` (full sync, CONTRACT.md §3.5). */
  listInboxMessageIds(max: number): Promise<string[]>;

  /** One fully parsed message. Rejects with `not_found` if it no longer exists. */
  getMessage(id: string): Promise<ProviderMessage>;

  /** Changes since `since` (incremental sync). Rejects with `cursor_expired` when `since` is too old. */
  listChanges(since: SyncCursor, pageToken?: string): Promise<ChangePage>;

  /** Sends a message (CONTRACT.md §4.3). */
  sendMessage(message: OutgoingMessage): Promise<{ id: string; threadId: string }>;

  /** Marks a message read; idempotent. Returns the message's labels afterwards (CONTRACT.md §4.4). */
  markRead(id: string): Promise<{ labels: string[] }>;

  /**
   * Marks a message unread; idempotent. Returns the message's labels afterwards.
   * @remarks Not used in v1 (CONTRACT.md §1).
   */
  markUnread(id: string): Promise<{ labels: string[] }>;

  /** Registers or renews push notifications for the inbox (CONTRACT.md §4.1, §4.5, §4.6). */
  watch(): Promise<WatchResult>;

  /** Forces an access-token refresh. Normal calls refresh automatically; both paths report through `OnTokens`. */
  refreshAccessToken(): Promise<TokenUpdate>;
}

/** Account-independent provider operations, and the way to obtain a `MailProvider`. */
export interface MailProviderFactory {
  readonly providerId: string;

  /** The provider's label IDs for inbox, unread and starred state, for applying label deltas. */
  readonly wellKnownLabels: { readonly inbox: string; readonly unread: string; readonly starred: string };

  /** Binds a provider to one mailbox. `onTokens` persists every refresh. */
  forAccount(credentials: AccountCredentials, onTokens: OnTokens): MailProvider;

  /**
   * Proves a refresh token by refreshing once, and reports identity and scopes.
   * @remarks Not used by v1 routes since connect switched to the code flow (CONTRACT.md §4.1b).
   */
  verifyRefreshToken(refreshToken: string): Promise<VerifiedGrant>;

  /** Orders two cursors issued by this provider: -1 if `a` is older, 0 if equal, 1 if newer. */
  compareCursors(a: SyncCursor, b: SyncCursor): -1 | 0 | 1;

  /** URL that starts the provider's OAuth consent flow (CONTRACT.md §4.1a). */
  buildAuthorizationUrl(options: { state: string; scopes: string[]; loginHint?: string }): string;

  /**
   * Exchanges an authorization code for credentials (CONTRACT.md §4.1b). `credentials.refreshToken`
   * is empty when the provider issued none.
   */
  exchangeAuthorizationCode(code: string): Promise<VerifiedGrant>;
}
