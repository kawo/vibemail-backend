import type { MessageWrite } from '../db/messages';
import type { MessageDTO } from '../types';

export type { MessageDTO };

const iso = (value: string): string => new Date(value).toISOString();

/** CONTRACT.md §3.4: a stored or just-written row, in camelCase, without internal columns. */
export function toMessageDTO(row: MessageWrite): MessageDTO {
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
