import type { MessageRow, MessagesRepository } from '../db/messages';
import type { UsersRepository } from '../db/users';
import {
  type MailProvider,
  type MailProviderFactory,
  type ProviderChange,
  type ProviderMessage,
  type SyncCursor,
  ProviderError,
} from '../providers/provider';

/** Initial (full) and incremental sync, CONTRACT.md §3.5. */

export const INITIAL_SYNC_LIMIT = 50;

export interface SyncDeps {
  provider: MailProvider;
  factory: Pick<MailProviderFactory, 'compareCursors' | 'wellKnownLabels'>;
  messages: MessagesRepository;
  users: UsersRepository;
  now?: () => Date;
}

export interface InitialSyncResult {
  stored: number;
  /** Messages listed but gone by the time `getMessage` ran. */
  skipped: number;
  /** The stored `users.history_id` afterwards; null for an empty inbox. */
  historyId: SyncCursor | null;
}

/** Maps a normalized message to a `messages` row (CONTRACT.md §5.1 column names). */
export function toMessageRow(userId: string, message: ProviderMessage, syncedAt: Date): MessageRow {
  return {
    user_id: userId,
    gmail_id: message.id,
    thread_id: message.threadId,
    label_ids: message.labels,
    is_read: message.isRead,
    is_starred: message.isStarred,
    snippet: message.snippet,
    history_id: message.syncCursor,
    internal_date: message.receivedAt.toISOString(),
    size_estimate: message.sizeBytes,
    subject: message.subject,
    from_address: message.from,
    to_address: message.to,
    cc_addresses: message.cc,
    bcc_addresses: message.bcc,
    rfc822_message_id: message.rfc822MessageId,
    in_reply_to: message.inReplyTo,
    references: message.references,
    date_header: message.dateHeader,
    body_plain: message.bodyText,
    body_html: message.bodyHtml,
    attachments: message.attachments,
    synced_at: syncedAt.toISOString(),
  };
}

/**
 * Stores the 50 newest INBOX messages and sets `users.history_id` from the newest one,
 * because `messages.list` responses carry no historyId. `history_id` never moves backwards.
 */
export async function runInitialSync(deps: SyncDeps, userId: string): Promise<InitialSyncResult> {
  const now = deps.now ?? (() => new Date());
  const ids = await deps.provider.listInboxMessageIds(INITIAL_SYNC_LIMIT);

  const fetched: ProviderMessage[] = [];
  let skipped = 0;
  for (const id of ids) {
    try {
      fetched.push(await deps.provider.getMessage(id));
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not_found') {
        skipped += 1;
        await deps.messages.deleteMessage(userId, id);
        continue;
      }
      throw error;
    }
  }

  const syncedAt = now();
  await deps.messages.upsertMessages(
    userId,
    fetched.map((message) => toMessageRow(userId, message, syncedAt)),
  );

  // IDs are newest first, so the first fetched message is the newest.
  const newest = fetched[0]?.syncCursor ?? null;
  if (newest === null) {
    return { stored: 0, skipped, historyId: null };
  }
  const current = (await deps.users.getHistoryId(userId)) as SyncCursor | null;
  const historyId =
    current !== null && deps.factory.compareCursors(current, newest) > 0 ? current : newest;
  await deps.users.recordSync(userId, historyId, syncedAt);
  return { stored: fetched.length, skipped, historyId };
}

export interface IncrementalSyncResult {
  applied: number;
  /** Messages referenced by a change but gone by the time `getMessage` ran. */
  skipped: number;
  historyId: SyncCursor;
}

/** Applies a label delta to a label set, preserving order. */
export function applyLabelDelta(current: string[], change: ProviderChange): string[] {
  if (change.type === 'labelsAdded') {
    return [...current, ...change.labels.filter((label) => !current.includes(label))];
  }
  if (change.type === 'labelsRemoved') {
    return current.filter((label) => !change.labels.includes(label));
  }
  return current;
}

/**
 * Incremental sync from the **stored** `history_id` (CONTRACT.md §3.5). Pages through every
 * change, applies them in order, and only then saves the last page's `historyId` (advance-only).
 * Rejects with `ProviderError('cursor_expired')` when `since` is too old; the caller then runs
 * `runInitialSync`.
 */
export async function runIncrementalSync(
  deps: SyncDeps,
  userId: string,
  since: SyncCursor,
): Promise<IncrementalSyncResult> {
  const now = deps.now ?? (() => new Date());
  const { unread, starred } = deps.factory.wellKnownLabels;

  const changes: ProviderChange[] = [];
  let pageToken: string | undefined;
  let cursor: SyncCursor;
  do {
    const page = await deps.provider.listChanges(since, pageToken);
    changes.push(...page.changes);
    cursor = page.cursor;
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);

  let applied = 0;
  let skipped = 0;

  /** Fetches and stores a full message; a 404 deletes any stored copy instead. */
  const fetchAndStore = async (gmailId: string): Promise<void> => {
    try {
      const message = await deps.provider.getMessage(gmailId);
      await deps.messages.upsertMessages(userId, [toMessageRow(userId, message, now())]);
      applied += 1;
    } catch (error) {
      if (error instanceof ProviderError && error.kind === 'not_found') {
        skipped += 1;
        await deps.messages.deleteMessage(userId, gmailId);
        return;
      }
      throw error;
    }
  };

  for (const change of changes) {
    switch (change.type) {
      case 'messageAdded':
        await fetchAndStore(change.messageId);
        break;
      case 'messageDeleted':
        await deps.messages.deleteMessage(userId, change.messageId);
        applied += 1;
        break;
      case 'labelsAdded':
      case 'labelsRemoved': {
        const current = await deps.messages.getLabels(userId, change.messageId);
        if (current === null) {
          // Not stored yet (e.g. an older message moved into the inbox): store it in full.
          await fetchAndStore(change.messageId);
          break;
        }
        const labels = applyLabelDelta(current, change);
        await deps.messages.updateLabels(userId, change.messageId, {
          labels,
          isRead: !labels.includes(unread),
          isStarred: labels.includes(starred),
          syncedAt: now(),
        });
        applied += 1;
        break;
      }
    }
  }

  const stored = (await deps.users.getHistoryId(userId)) as SyncCursor | null;
  const historyId = stored !== null && deps.factory.compareCursors(stored, cursor) > 0 ? stored : cursor;
  await deps.users.recordSync(userId, historyId, now());
  return { applied, skipped, historyId };
}
