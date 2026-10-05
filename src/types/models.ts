// Hand-written types over the generated `database.ts`: DB row types with
// `attachments` narrowed from `Json`, the §5.5 RPC payloads, and the
// CONTRACT.md §3.4 DTOs. `database.ts` is generated, never edited by hand:
// `supabase gen types typescript --local > src/types/database.ts` (or `--linked`
// against a project that has the migration applied).
//
// Object shapes that travel inside `jsonb` are `type` aliases, not interfaces,
// so they stay assignable to the generated `Json` type.

import type { Database, Tables, TablesInsert, TablesUpdate } from './database';

// ---------------------------------------------------------------------------
// CONTRACT.md §3.4
// ---------------------------------------------------------------------------

export type AttachmentMeta = {
  partId: string;
  filename: string;
  mimeType: string;
  size: number; // bytes
  attachmentId: string;
};

export interface MessageDTO {
  gmailId: string;
  threadId: string;
  labelIds: string[];
  isRead: boolean;
  snippet: string;
  historyId: string;
  internalDate: string; // ISO-8601
  sizeEstimate: number;
  subject: string | null;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  rfc822MessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  dateHeader: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: AttachmentMeta[];
  syncedAt: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// CONTRACT.md §5.1 `messages`
// ---------------------------------------------------------------------------

export type MessageRow = Omit<Tables<'messages'>, 'attachments'> & {
  attachments: AttachmentMeta[];
};

export type MessageInsert = Omit<TablesInsert<'messages'>, 'attachments'> & {
  attachments?: AttachmentMeta[];
};

export type MessageUpdate = Omit<TablesUpdate<'messages'>, 'attachments'> & {
  attachments?: AttachmentMeta[];
};

// ---------------------------------------------------------------------------
// CONTRACT.md §5.2 `users` (connected Gmail account). `refresh_token` and
// `access_token` hold §5.4 ciphertext, never plaintext.
// ---------------------------------------------------------------------------

export type UserRow = Tables<'users'>;
export type UserInsert = TablesInsert<'users'>;
export type UserUpdate = TablesUpdate<'users'>;

// ---------------------------------------------------------------------------
// CONTRACT.md §5.5 `apply_sync_batch` / `advance_last_history_id`
// ---------------------------------------------------------------------------

/** One `p_upserts` element. The function sets `user_id` and `synced_at` itself. */
export type SyncUpsertRow = Omit<
  MessageInsert,
  'id' | 'user_id' | 'synced_at' | 'created_at' | 'updated_at'
>;

/** One `p_label_updates` element. */
export type SyncLabelUpdate = {
  gmail_id: string;
  label_ids: string[];
};

export type ApplySyncBatchArgs = {
  p_user_id: string;
  p_upserts: SyncUpsertRow[];
  p_deletes: string[];
  p_label_updates: SyncLabelUpdate[];
  p_new_history_id: string; // digit string
};

export type AdvanceLastHistoryIdArgs =
  Database['public']['Functions']['advance_last_history_id']['Args'];

/** Compile-time proof that `ApplySyncBatchArgs` can be passed to `.rpc('apply_sync_batch', …)`. */
export type ApplySyncBatchArgsIsRpcCompatible =
  ApplySyncBatchArgs extends Database['public']['Functions']['apply_sync_batch']['Args']
    ? true
    : never;
