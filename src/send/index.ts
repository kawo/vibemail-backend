import type { MessageWrite, MessagesRepository } from '../db/messages';
import type { UsersRepository } from '../db/users';
import { ApiError } from '../middleware/errors';
import { type MailProviderFactory, ProviderError } from '../providers/provider';
import { apiErrorFromProvider, providerForUser } from '../services/gmailAccount';

/** Send layer, CONTRACT.md §4.3: validate, send through the user's provider, store the sent message. */

export interface SendInput {
  to: string | string[];
  subject: string;
  body: string;
  threadId?: string;
}

export interface SendDeps {
  factory: MailProviderFactory;
  users: UsersRepository;
  messages: MessagesRepository;
  now?: () => Date;
  log?: (message: string, error: unknown) => void;
}

const MAX_RECIPIENTS = 100;
const MAX_SUBJECT = 998;
const ADDR_SPEC = /^[^\s@<>",;:\\]+@[^\s@<>",;:\\]+\.[^\s@<>",;:\\]+$/;
const NAME_ADDR = /^(?:"[^"\r\n]*"|[^<>"\r\n]*?)\s*<([^<>\s]+)>$/;
const THREAD_ID = /^[A-Za-z0-9]+$/;
const CR_LF = /[\r\n]/;

export function isValidAddress(value: string): boolean {
  if (CR_LF.test(value)) {
    return false;
  }
  const trimmed = value.trim();
  const named = NAME_ADDR.exec(trimmed);
  return ADDR_SPEC.test(named ? (named[1] ?? '') : trimmed);
}

export interface ValidatedSend {
  to: string[];
  subject: string;
  body: string;
  threadId?: string;
}

/** Validates an untrusted request body. Collects every issue into `details.issues`. */
export function validateSendInput(input: unknown): ValidatedSend {
  const issues: Array<{ field: string; message: string }> = [];
  const record = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;

  const rawTo = record.to;
  const to = typeof rawTo === 'string' ? [rawTo] : Array.isArray(rawTo) ? rawTo : null;
  if (!to || to.length === 0) {
    issues.push({ field: 'to', message: 'at least one recipient is required' });
  } else if (to.length > MAX_RECIPIENTS) {
    issues.push({ field: 'to', message: `at most ${MAX_RECIPIENTS} recipients` });
  } else {
    to.forEach((address, i) => {
      if (typeof address !== 'string' || !isValidAddress(address)) {
        issues.push({ field: `to[${i}]`, message: 'not a valid email address' });
      }
    });
  }

  const subject = record.subject;
  if (typeof subject !== 'string') {
    issues.push({ field: 'subject', message: 'must be a string' });
  } else if (CR_LF.test(subject)) {
    issues.push({ field: 'subject', message: 'must not contain line breaks' });
  } else if (subject.length > MAX_SUBJECT) {
    issues.push({ field: 'subject', message: `at most ${MAX_SUBJECT} characters` });
  }

  const body = record.body;
  if (typeof body !== 'string') {
    issues.push({ field: 'body', message: 'must be a string' });
  }

  const threadId = record.threadId;
  if (threadId !== undefined && (typeof threadId !== 'string' || !THREAD_ID.test(threadId))) {
    issues.push({ field: 'threadId', message: 'must be a Gmail thread ID' });
  }

  if (issues.length > 0) {
    throw new ApiError('VALIDATION_FAILED', 'invalid send request', { details: { issues } });
  }
  return {
    to: (to as string[]).map((a) => a.trim()),
    subject: subject as string,
    body: body as string,
    ...(typeof threadId === 'string' ? { threadId } : {}),
  };
}

const defaultLog = (message: string, error: unknown): void => {
  console.error(message, error instanceof Error ? error.message : error);
};

/**
 * Sends for an authenticated user and returns the stored row. `messages.send` returns only
 * `id`, `threadId` and `labelIds`, so the sent message is fetched back with `getMessage` and
 * normalized like synced mail.
 */
export async function sendForUser(deps: SendDeps, userId: string, input: unknown): Promise<MessageWrite> {
  const log = deps.log ?? defaultLog;
  const now = deps.now ?? (() => new Date());
  const request = validateSendInput(input);

  const from = await deps.users.getUserEmail(userId);
  if (!from) {
    throw new ApiError('GMAIL_NOT_CONNECTED', 'Gmail is not connected');
  }
  const provider = await providerForUser(deps, userId);

  let sent: { id: string; threadId: string };
  try {
    sent = await provider.sendMessage({
      from,
      to: request.to,
      subject: request.subject,
      text: request.body,
      ...(request.threadId ? { threadId: request.threadId } : {}),
    });
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.kind === 'revoked') {
        await deps.users.clearUserTokens(userId);
      }
      if (error.kind === 'not_found' && request.threadId) {
        throw new ApiError('MESSAGE_NOT_FOUND', 'thread not found in this mailbox', {
          details: { threadId: request.threadId },
        });
      }
      throw apiErrorFromProvider(error);
    }
    throw error;
  }

  // The message is sent. From here on, every failure reports sentGmailId so the client never resends.
  try {
    const message = await provider.getMessage(sent.id);
    return await deps.messages.upsertMessage(userId, message, now());
  } catch (error) {
    log('storing a sent message failed', error);
    const details = { sentGmailId: sent.id };
    if (error instanceof ProviderError) {
      throw new ApiError('GMAIL_UPSTREAM_ERROR', 'message sent, but fetching it back failed', { details });
    }
    throw new ApiError('INTERNAL', 'message sent, but storing it failed', { details });
  }
}
