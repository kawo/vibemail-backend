import type { gmail_v1 } from 'googleapis';
import { type AttachmentMeta, type ProviderMessage, type SyncCursor, ProviderError } from '../provider';

/**
 * Normalizes a Gmail `format=full` message into a `ProviderMessage` (CONTRACT.md §5.1 sources).
 * Pure: no I/O.
 */

const INBOX = 'INBOX';
const UNREAD = 'UNREAD';
const STARRED = 'STARRED';

type Part = gmail_v1.Schema$MessagePart;

/** First header with this name, matched case-insensitively. */
export function header(part: Part | undefined, name: string): string | null {
  const wanted = name.toLowerCase();
  const found = part?.headers?.find((h) => h.name?.toLowerCase() === wanted);
  return found?.value ?? null;
}

/** Splits an address-list header on commas outside quotes and angle brackets. */
export function splitAddresses(value: string | null): string[] {
  if (!value) {
    return [];
  }
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  let depth = 0;
  for (const ch of value) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && ch === '<') {
      depth += 1;
    } else if (!inQuotes && ch === '>') {
      depth = Math.max(0, depth - 1);
    }
    if (ch === ',' && !inQuotes && depth === 0) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

export function decodeBase64Url(data: string | null | undefined): string | null {
  if (!data) {
    return null;
  }
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Depth-first walk over the MIME tree, root included. */
function* walk(part: Part | undefined): Generator<Part> {
  if (!part) {
    return;
  }
  yield part;
  for (const child of part.parts ?? []) {
    yield* walk(child);
  }
}

/** Body of the first non-attachment part with this MIME type; a single-part payload uses `payload.body.data`. */
function bodyOf(payload: Part | undefined, mimeType: 'text/plain' | 'text/html'): string | null {
  for (const part of walk(payload)) {
    if (part.mimeType === mimeType && !part.filename && part.body?.data) {
      return decodeBase64Url(part.body.data);
    }
  }
  return null;
}

function attachmentsOf(payload: Part | undefined): AttachmentMeta[] {
  const out: AttachmentMeta[] = [];
  for (const part of walk(payload)) {
    if (part.filename && part.body?.attachmentId) {
      out.push({
        partId: part.partId ?? '',
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
      });
    }
  }
  return out;
}

export function parseGmailMessage(message: gmail_v1.Schema$Message): ProviderMessage {
  const { id, threadId, historyId, internalDate } = message;
  if (!id || !threadId || !historyId || !internalDate) {
    throw new ProviderError('upstream', `Gmail message ${id ?? '?'} lacks id, threadId, historyId or internalDate`);
  }
  const labels = message.labelIds ?? [];
  const payload = message.payload ?? undefined;
  return {
    id,
    threadId,
    labels,
    isRead: !labels.includes(UNREAD),
    isStarred: labels.includes(STARRED),
    inInbox: labels.includes(INBOX),
    receivedAt: new Date(Number(internalDate)),
    sizeBytes: message.sizeEstimate ?? 0,
    snippet: message.snippet ?? '',
    subject: header(payload, 'Subject'),
    from: header(payload, 'From') ?? '',
    to: splitAddresses(header(payload, 'To')),
    cc: splitAddresses(header(payload, 'Cc')),
    bcc: splitAddresses(header(payload, 'Bcc')),
    rfc822MessageId: header(payload, 'Message-ID'),
    inReplyTo: header(payload, 'In-Reply-To'),
    references: header(payload, 'References'),
    dateHeader: header(payload, 'Date'),
    bodyText: bodyOf(payload, 'text/plain'),
    bodyHtml: bodyOf(payload, 'text/html'),
    attachments: attachmentsOf(payload),
    syncCursor: historyId as SyncCursor,
  };
}
