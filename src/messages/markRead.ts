import type { MessageRow, MessagesRepository } from '../db/messages';
import type { UsersRepository } from '../db/users';
import { ApiError } from '../middleware/errors';
import { type MailProviderFactory, ProviderError } from '../providers/provider';
import { apiErrorFromProvider, providerForUser } from '../services/gmailAccount';

/** Mark as read, CONTRACT.md §4.4 (BUILD_SEQUENCE.md unit 6). Idempotent. */

export interface MarkReadDeps {
  factory: MailProviderFactory;
  users: UsersRepository;
  messages: MessagesRepository;
  now?: () => Date;
}

const GMAIL_ID = /^[A-Za-z0-9]+$/;

export async function markMessageRead(deps: MarkReadDeps, userId: string, gmailId: string): Promise<MessageRow> {
  if (!GMAIL_ID.test(gmailId)) {
    throw new ApiError('VALIDATION_FAILED', 'invalid message id', {
      details: { issues: [{ field: 'id', message: 'must be a Gmail message ID' }] },
    });
  }
  const now = deps.now ?? (() => new Date());

  // Not stored for this user (including another user's message): no Gmail call.
  const stored = await deps.messages.getMessage(userId, gmailId);
  if (!stored) {
    throw new ApiError('MESSAGE_NOT_FOUND', 'message not found');
  }

  const provider = await providerForUser(deps, userId);
  let labels: string[];
  try {
    ({ labels } = await provider.markRead(gmailId));
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.kind === 'not_found') {
        await deps.messages.deleteMessage(userId, gmailId);
        throw new ApiError('MESSAGE_NOT_FOUND', 'message no longer exists in Gmail');
      }
      if (error.kind === 'revoked') {
        await deps.users.clearUserTokens(userId);
      }
      throw apiErrorFromProvider(error);
    }
    throw error;
  }

  const { unread, starred } = deps.factory.wellKnownLabels;
  const syncedAt = now();
  const update = { labels, isRead: !labels.includes(unread), isStarred: labels.includes(starred), syncedAt };
  await deps.messages.updateLabels(userId, gmailId, update);
  return {
    ...stored,
    label_ids: update.labels,
    is_read: update.isRead,
    is_starred: update.isStarred,
    synced_at: syncedAt.toISOString(),
  };
}
