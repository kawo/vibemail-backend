// Hand-written types over the generated `database.ts`: DB row types with
// `attachments` narrowed from `Json`, and the CONTRACT.md §3.4 DTOs.
// `database.ts` is generated, never edited by hand: `npm run db:types`
// (`supabase gen types typescript --linked`) against the dev/test project with
// the migration applied, or `--local` after `supabase db reset`.
//
// `AttachmentMeta` is a `type` alias, not an interface, so it stays assignable
// to the generated `Json` type when written into `jsonb`.

import type { Tables, TablesInsert, TablesUpdate } from './database';

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
  isStarred: boolean;
  snippet: string;
  historyId: string;
  internalDate: string; // ISO-8601
  sizeEstimate: number;
  subject: string | null;
  fromAddress: string;
  toAddress: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  rfc822MessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  dateHeader: string | null;
  bodyPlain: string | null;
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
// CONTRACT.md §5.2 `users` (one connected Google account per user, keyed by
// `google_id`). `refresh_token` and `access_token` hold §5.4 ciphertext.
// ---------------------------------------------------------------------------

export type UserRow = Tables<'users'>;
export type UserInsert = TablesInsert<'users'>;
export type UserUpdate = TablesUpdate<'users'>;
