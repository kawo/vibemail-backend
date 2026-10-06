import type { MessageRow } from '../db/messages';
import type { AttachmentMeta } from '../providers/provider';

/** CONTRACT.md §3.4: the `messages` row in camelCase, without internal columns. */
export interface MessageDTO {
  gmailId: string;
  threadId: string;
  labelIds: string[];
  isRead: boolean;
  isStarred: boolean;
  snippet: string;
  historyId: string;
  internalDate: string;
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
  syncedAt: string;
}

const iso = (value: string): string => new Date(value).toISOString();

export function toMessageDTO(row: MessageRow): MessageDTO {
  return {
    gmailId: row.gmail_id,
    threadId: row.thread_id,
    labelIds: row.label_ids,
    isRead: row.is_read,
    isStarred: row.is_starred,
    snippet: row.snippet,
    historyId: row.history_id,
    internalDate: iso(row.internal_date),
    sizeEstimate: row.size_estimate,
    subject: row.subject,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    ccAddresses: row.cc_addresses,
    bccAddresses: row.bcc_addresses,
    rfc822MessageId: row.rfc822_message_id,
    inReplyTo: row.in_reply_to,
    references: row.references,
    dateHeader: row.date_header,
    bodyPlain: row.body_plain,
    bodyHtml: row.body_html,
    attachments: row.attachments,
    syncedAt: iso(row.synced_at),
  };
}
