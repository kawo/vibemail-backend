import type { SupabaseClient } from '@supabase/supabase-js';
import type { AttachmentMeta } from '../providers/provider';
import { DatabaseError } from './users';

/**
 * Repository for the `messages` table (CONTRACT.md §5.1). Upserts conflict on
 * `(user_id, gmail_id)`, so two users holding the same Gmail message ID never collide (§5.3).
 */

/**
 * A `messages` row as written by sync. Defined locally because `src/types/` belongs to the
 * schema session; replace with the generated row type after the merge.
 */
export interface MessageRow {
  user_id: string;
  gmail_id: string;
  thread_id: string;
  label_ids: string[];
  is_read: boolean;
  is_starred: boolean;
  snippet: string;
  history_id: string;
  internal_date: string;
  size_estimate: number;
  subject: string | null;
  from_address: string;
  to_address: string[];
  cc_addresses: string[];
  bcc_addresses: string[];
  rfc822_message_id: string | null;
  in_reply_to: string | null;
  references: string | null;
  date_header: string | null;
  body_plain: string | null;
  body_html: string | null;
  attachments: AttachmentMeta[];
  synced_at: string;
}

export interface MessagesRepository {
  /** Upserts rows on `(user_id, gmail_id)`. Every row must belong to `userId`. */
  upsertMessages(userId: string, rows: MessageRow[]): Promise<void>;
  deleteMessage(userId: string, gmailId: string): Promise<void>;
  /** Stored labels of one message, or null when it is not stored. */
  getLabels(userId: string, gmailId: string): Promise<string[] | null>;
  /** Replaces a stored message's labels and the flags derived from them. */
  updateLabels(
    userId: string,
    gmailId: string,
    update: { labels: string[]; isRead: boolean; isStarred: boolean; syncedAt: Date },
  ): Promise<void>;
}

export function createMessagesRepository(db: SupabaseClient): MessagesRepository {
  return {
    async upsertMessages(userId, rows) {
      if (rows.length === 0) {
        return;
      }
      if (rows.some((row) => row.user_id !== userId)) {
        throw new DatabaseError('messages upsert', new Error('row user_id does not match the scoped user'));
      }
      const { error } = await db.from('messages').upsert(rows, { onConflict: 'user_id,gmail_id' });
      if (error) {
        throw new DatabaseError('messages upsert', error);
      }
    },

    async getLabels(userId, gmailId) {
      const { data, error } = await db
        .from('messages')
        .select('label_ids')
        .eq('user_id', userId)
        .eq('gmail_id', gmailId)
        .maybeSingle()
        .overrideTypes<{ label_ids: string[] } | null, { merge: false }>();
      if (error) {
        throw new DatabaseError('messages label lookup', error);
      }
      return data?.label_ids ?? null;
    },

    async updateLabels(userId, gmailId, update) {
      const { error } = await db
        .from('messages')
        .update({
          label_ids: update.labels,
          is_read: update.isRead,
          is_starred: update.isStarred,
          synced_at: update.syncedAt.toISOString(),
        })
        .eq('user_id', userId)
        .eq('gmail_id', gmailId);
      if (error) {
        throw new DatabaseError('messages label update', error);
      }
    },

    async deleteMessage(userId, gmailId) {
      const { error } = await db.from('messages').delete().eq('user_id', userId).eq('gmail_id', gmailId);
      if (error) {
        throw new DatabaseError('messages delete', error);
      }
    },
  };
}
