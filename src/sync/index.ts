import type { MessageRow, MessagesRepository } from '../db/messages';
import type { UsersRepository } from '../db/users';
import {
  type MailProvider,
  type MailProviderFactory,
  type ProviderMessage,
  type SyncCursor,
  ProviderError,
} from '../providers/provider';

/** Initial (full) sync, CONTRACT.md §3.5. Incremental sync is added later in BUILD_SEQUENCE.md unit 3. */

export const INITIAL_SYNC_LIMIT = 50;

export interface SyncDeps {
  provider: MailProvider;
  factory: Pick<MailProviderFactory, 'compareCursors'>;
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
