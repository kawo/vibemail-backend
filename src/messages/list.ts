import type { ListCursor, MessagesRepository } from '../db/messages';
import type { UsersRepository } from '../db/users';
import { ApiError } from '../middleware/errors';
import { type MessageDTO, toMessageDTO } from './dto';

/** Message list read side, CONTRACT.md §4.2. Reads the DB only; never calls Gmail. */

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export interface ListDeps {
  users: UsersRepository;
  messages: MessagesRepository;
}

export interface ListResponse {
  messages: MessageDTO[];
  nextCursor: string | null;
  lastSyncedAt: string | null;
}

/** Opaque cursor: `base64url(JSON.stringify({ d: internalDateISO, g: gmailId }))`. */
export function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify({ d: cursor.internalDate, g: cursor.gmailId }), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): ListCursor {
  const invalid = () =>
    new ApiError('VALIDATION_FAILED', 'invalid cursor', { details: { issues: [{ field: 'cursor', message: 'malformed' }] } });
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const { d, g } = (parsed ?? {}) as { d?: unknown; g?: unknown };
  if (typeof d !== 'string' || typeof g !== 'string' || !/^[A-Za-z0-9]+$/.test(g) || Number.isNaN(Date.parse(d))) {
    throw invalid();
  }
  return { internalDate: new Date(d).toISOString(), gmailId: g };
}

export function parseListQuery(url: URL): { limit: number; cursor: ListCursor | null } {
  const rawLimit = url.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_LIMIT) {
      throw new ApiError('VALIDATION_FAILED', 'invalid limit', {
        details: { issues: [{ field: 'limit', message: `integer 1..${MAX_LIMIT}` }] },
      });
    }
    limit = Number(rawLimit);
  }
  const rawCursor = url.searchParams.get('cursor');
  return { limit, cursor: rawCursor ? decodeCursor(rawCursor) : null };
}

export async function listMessages(
  deps: ListDeps,
  userId: string,
  query: { limit: number; cursor: ListCursor | null },
): Promise<ListResponse> {
  const credentials = await deps.users.getUserCredentials(userId);
  if (!credentials) {
    throw new ApiError('GMAIL_NOT_CONNECTED', 'Gmail is not connected');
  }
  // Fetch one extra row to know whether another page exists.
  const rows = await deps.messages.listInbox(userId, query.limit + 1, query.cursor);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  const lastSyncedAt = await deps.users.getLastSyncedAt(userId);
  return {
    messages: page.map(toMessageDTO),
    nextCursor:
      rows.length > query.limit && last
        ? encodeCursor({ internalDate: new Date(last.internal_date).toISOString(), gmailId: last.gmail_id })
        : null,
    lastSyncedAt: lastSyncedAt ? lastSyncedAt.toISOString() : null,
  };
}
