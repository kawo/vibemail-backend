import type { MessageRow, MessagesRepository } from '../../src/db/messages';
import type { ConnectedAccount, ConnectedUserInput, UpsertResult, UsersRepository } from '../../src/db/users';
import type { AccountCredentials, TokenUpdate } from '../../src/providers/provider';

export interface MemoryUserRow extends ConnectedUserInput {
  watch?: Date;
  historyId: string | null;
  lastSyncedAt: Date | null;
}

/** In-memory `UsersRepository`, keyed by user ID. */
export class MemoryUsers implements UsersRepository {
  rows = new Map<string, MemoryUserRow>();
  tokenWrites: Array<[string, TokenUpdate]> = [];
  upsertResult: UpsertResult = 'ok';
  cleared: string[] = [];
  throwOnRead: Error | null = null;

  async upsertConnectedUser(input: ConnectedUserInput): Promise<UpsertResult> {
    if (this.upsertResult === 'ok') {
      this.rows.set(input.userId, { ...input, historyId: null, lastSyncedAt: null });
    }
    return this.upsertResult;
  }
  async updateUserTokens(userId: string, update: TokenUpdate): Promise<void> {
    this.tokenWrites.push([userId, update]);
  }
  async getUserCredentials(userId: string): Promise<AccountCredentials | null> {
    if (this.throwOnRead) {
      throw this.throwOnRead;
    }
    return this.rows.get(userId)?.credentials ?? null;
  }
  async updateWatch(userId: string, expiresAt: Date): Promise<void> {
    const row = this.rows.get(userId);
    if (row) {
      row.watch = expiresAt;
    }
  }
  async getHistoryId(userId: string): Promise<string | null> {
    return this.rows.get(userId)?.historyId ?? null;
  }
  async recordSync(userId: string, historyId: string, syncedAt: Date): Promise<void> {
    const row = this.rows.get(userId);
    if (row) {
      row.historyId = historyId;
      row.lastSyncedAt = syncedAt;
    }
  }
  async findAccountByEmailUnscoped(email: string): Promise<ConnectedAccount | null> {
    const row = [...this.rows.values()].find((r) => r.email === email);
    if (!row || this.cleared.includes(row.userId)) {
      return null;
    }
    return { userId: row.userId, historyId: row.historyId, credentials: row.credentials };
  }
  async clearUserTokens(userId: string): Promise<void> {
    this.cleared.push(userId);
  }
}

/** In-memory `MessagesRepository`, keyed by `(user_id, gmail_id)` like the real conflict target. */
export class MemoryMessages implements MessagesRepository {
  rows = new Map<string, MessageRow>();
  upsertCalls = 0;
  deleted: Array<[string, string]> = [];

  static key(userId: string, gmailId: string): string {
    return `${userId}:${gmailId}`;
  }

  async upsertMessages(userId: string, rows: MessageRow[]): Promise<void> {
    this.upsertCalls += 1;
    for (const row of rows) {
      if (row.user_id !== userId) {
        throw new Error('row user_id does not match the scoped user');
      }
      this.rows.set(MemoryMessages.key(row.user_id, row.gmail_id), row);
    }
  }
  async deleteMessage(userId: string, gmailId: string): Promise<void> {
    this.deleted.push([userId, gmailId]);
    this.rows.delete(MemoryMessages.key(userId, gmailId));
  }
  async getLabels(userId: string, gmailId: string): Promise<string[] | null> {
    return this.rows.get(MemoryMessages.key(userId, gmailId))?.label_ids ?? null;
  }
  async updateLabels(
    userId: string,
    gmailId: string,
    update: { labels: string[]; isRead: boolean; isStarred: boolean; syncedAt: Date },
  ): Promise<void> {
    const row = this.rows.get(MemoryMessages.key(userId, gmailId));
    if (row) {
      this.rows.set(MemoryMessages.key(userId, gmailId), {
        ...row,
        label_ids: update.labels,
        is_read: update.isRead,
        is_starred: update.isStarred,
        synced_at: update.syncedAt.toISOString(),
      });
    }
  }
  forUser(userId: string): MessageRow[] {
    return [...this.rows.values()].filter((row) => row.user_id === userId);
  }
}
