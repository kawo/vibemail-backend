import { timingSafeEqual } from 'crypto';
import type { MessagesRepository } from '../db/messages';
import type { UsersRepository } from '../db/users';
import { type ErrorCode, ApiError } from '../middleware/errors';
import { type MailProviderFactory, type SyncCursor, ProviderError } from '../providers/provider';
import { persistTokensFor } from '../services/gmailAccount';
import { runIncrementalSync, runInitialSync } from '../sync';

/**
 * Gmail Pub/Sub push receiver, CONTRACT.md §4.5. The request is checked and decoded first;
 * then it is acknowledged with `200` at once, and the sync runs in the background (`waitUntil`).
 * Failures after the ack are logged and not retried: the next notification catches up, because
 * every sync starts from the stored `history_id`.
 */

export interface GmailNotification {
  emailAddress: string;
  historyId: SyncCursor;
}

export interface WebhookDeps {
  factory: MailProviderFactory;
  users: UsersRepository;
  messages: MessagesRepository;
  /** `GOOGLE_PUBSUB_VERIFICATION_TOKEN`; undefined or empty makes every request fail closed. */
  verificationToken: string | undefined;
  /** Keeps the function alive for background work: `waitUntil` from `@vercel/functions`. */
  waitUntil: (promise: Promise<unknown>) => void;
  log?: (message: string, error?: unknown) => void;
}

const defaultLog = (message: string, error?: unknown): void => {
  console.error(message, error instanceof Error ? error.message : (error ?? ''));
};

const STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  GMAIL_NOT_CONNECTED: 409,
  GMAIL_TOKEN_REVOKED: 401,
  VALIDATION_FAILED: 400,
  MESSAGE_NOT_FOUND: 404,
  GMAIL_RATE_LIMITED: 429,
  GMAIL_UPSTREAM_ERROR: 502,
  SYNC_FAILED: 502,
  INTERNAL: 500,
};

function errorResponse(error: ApiError): Response {
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        retryable: false,
        ...(error.details ? { details: error.details } : {}),
      },
    },
    { status: STATUS[error.code] },
  );
}

/** Constant-time comparison of the `?token=` query parameter with the configured token. */
export function verifyPushToken(provided: string | null, expected: string | undefined): void {
  if (!expected) {
    throw new ApiError('INTERNAL', 'webhook verification token is not configured');
  }
  const a = Buffer.from(provided ?? '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ApiError('UNAUTHENTICATED', 'invalid or missing token');
  }
}

/** Decodes a Pub/Sub push body: `message.data` is base64 JSON `{ emailAddress, historyId }`. */
export function decodeNotification(body: unknown): GmailNotification {
  const invalid = (why: string) => new ApiError('VALIDATION_FAILED', `invalid Pub/Sub push body: ${why}`);
  if (typeof body !== 'object' || body === null || !('message' in body)) {
    throw invalid('missing message');
  }
  const message = (body as { message: unknown }).message;
  const data =
    typeof message === 'object' && message !== null && 'data' in message ? (message as { data: unknown }).data : null;
  if (typeof data !== 'string' || data.length === 0) {
    throw invalid('missing message.data');
  }
  let decoded: unknown;
  try {
    // Pub/Sub sends standard base64; Buffer also accepts the URL-safe alphabet.
    decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    throw invalid('message.data is not base64 JSON');
  }
  const { emailAddress, historyId } = (decoded ?? {}) as { emailAddress?: unknown; historyId?: unknown };
  const id = typeof historyId === 'number' ? String(historyId) : historyId;
  if (typeof emailAddress !== 'string' || !emailAddress || typeof id !== 'string' || !/^\d+$/.test(id)) {
    throw invalid('expected { emailAddress, historyId }');
  }
  return { emailAddress, historyId: id as SyncCursor };
}

export type ProcessOutcome =
  | 'unknown_account'
  | 'stale'
  | 'full_sync'
  | 'incremental_sync'
  | 'fallback_full_sync'
  | 'revoked';

/**
 * The background part: find the account, skip stale notifications, then sync from the
 * **stored** `history_id`, never from the notification's (CONTRACT.md §4.5 step 4).
 */
export async function processNotification(deps: WebhookDeps, notification: GmailNotification): Promise<ProcessOutcome> {
  const account = await deps.users.findAccountByEmailUnscoped(notification.emailAddress);
  if (!account) {
    return 'unknown_account';
  }
  const stored = account.historyId as SyncCursor | null;
  if (stored !== null && deps.factory.compareCursors(notification.historyId, stored) <= 0) {
    return 'stale';
  }

  const provider = deps.factory.forAccount(account.credentials, persistTokensFor(deps.users, account.userId));
  const syncDeps = { provider, factory: deps.factory, messages: deps.messages, users: deps.users };
  try {
    if (stored === null) {
      await runInitialSync(syncDeps, account.userId);
      return 'full_sync';
    }
    try {
      await runIncrementalSync(syncDeps, account.userId, stored);
      return 'incremental_sync';
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'cursor_expired') {
        await runInitialSync(syncDeps, account.userId);
        return 'fallback_full_sync';
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'revoked') {
      await deps.users.clearUserTokens(account.userId);
      return 'revoked';
    }
    throw error;
  }
}

/** HTTP entry: check, decode, ack with 200, and hand the sync to `waitUntil`. */
export async function handleGmailPush(request: Request, deps: WebhookDeps): Promise<Response> {
  const log = deps.log ?? defaultLog;
  let notification: GmailNotification;
  try {
    verifyPushToken(new URL(request.url).searchParams.get('token'), deps.verificationToken);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ApiError('VALIDATION_FAILED', 'invalid Pub/Sub push body: not JSON');
    }
    notification = decodeNotification(body);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.code === 'INTERNAL') {
        log(error.message);
      }
      return errorResponse(error);
    }
    throw error;
  }

  deps.waitUntil(
    processNotification(deps, notification).catch((error: unknown) => {
      log('webhook sync failed after ack', error);
    }),
  );
  return new Response(null, { status: 200 });
}
