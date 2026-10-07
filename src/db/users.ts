import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccountCredentials, TokenUpdate } from '../providers/provider';
import type { Database, UserRow } from '../types';
import { TokenDecryptionError, decryptToken, encryptToken } from './crypto';

/**
 * Repository for the `users` table (CONTRACT.md §5.2). All SQL for it lives here, every
 * user-scoped query filters on `user_id` (§5.3), and tokens are encrypted on write and
 * decrypted on read (§5.4). Row shapes come from the generated `src/types/database.ts`.
 */

/** The columns needed to decide linking and to decrypt credentials. */
type TokenColumns = Pick<
  UserRow,
  'google_id' | 'user_id' | 'history_id' | 'refresh_token' | 'access_token' | 'access_token_expires_at'
>;
const TOKEN_COLUMNS = 'google_id, user_id, history_id, refresh_token, access_token, access_token_expires_at';

export interface ConnectedUserInput {
  googleId: string;
  userId: string;
  email: string;
  scopes: string[];
  credentials: AccountCredentials;
}

/** An account found without a user scope (webhook, CONTRACT.md §5.3). */
export interface ConnectedAccount {
  userId: string;
  historyId: string | null;
  credentials: AccountCredentials;
}

/** A cron renewal candidate. `credentials` is null when the stored tokens cannot be decrypted. */
export interface RenewalCandidate {
  userId: string;
  credentials: AccountCredentials | null;
}

export type UpsertResult = 'ok' | 'google_account_linked_elsewhere' | 'another_google_account_linked';

export interface UsersRepository {
  upsertConnectedUser(input: ConnectedUserInput): Promise<UpsertResult>;
  /** The user's `users` row as stored (tokens still encrypted), or null. */
  getUser(userId: string): Promise<UserRow | null>;
  /**
   * Persists a token refresh; called by the token persistence listener. Encrypts the access
   * token, writes it with its expiry as a pair (§3.1), and the refresh token only when rotated.
   */
  updateUserTokens(userId: string, update: TokenUpdate): Promise<void>;
  /** Decrypted credentials, or null when the user has no row or no refresh token. */
  getUserCredentials(userId: string): Promise<AccountCredentials | null>;
  /** After a watch registration or renewal: writes `watch_expiration`. Gmail returns no resource ID. */
  updateWatchExpiry(userId: string, expiresAt: Date): Promise<void>;
  /** The connected mailbox address (`users.email`), or null when the user has no row. */
  getUserEmail(userId: string): Promise<string | null>;
  /** When the last sync completed (`last_synced_at`), or null. */
  getLastSyncedAt(userId: string): Promise<Date | null>;
  /** The stored sync position (`history_id`), or null when a full sync is needed. */
  getHistoryId(userId: string): Promise<string | null>;
  /**
   * After each sync: writes `users.history_id` and `last_synced_at`. Callers enforce advance-only
   * (CONTRACT.md §4.5 step 6).
   */
  updateHistoryId(userId: string, historyId: string, syncedAt: Date): Promise<void>;
  /**
   * Unscoped lookup by mailbox email, for the webhook only (§5.3). Null when there is no row
   * or no refresh token.
   */
  findAccountByEmailUnscoped(email: string): Promise<ConnectedAccount | null>;
  /**
   * Unscoped, for the cron job only (§4.6, §5.3): every account with a refresh token whose
   * `watch_expiration` is null or earlier than `watchExpiringBefore`.
   */
  listConnectedAccountsUnscoped(filter: { watchExpiringBefore: Date }): Promise<RenewalCandidate[]>;
  /** Revocation: clears both tokens and the expiry (§4.5, §4.6). */
  clearUserTokens(userId: string): Promise<void>;
}

/** Thrown for unexpected database failures. Maps to `500 INTERNAL`. */
export class DatabaseError extends Error {
  readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super(`database error during ${operation}`);
    this.name = 'DatabaseError';
    this.cause = cause;
  }
}

const UNIQUE_VIOLATION = '23505';

export function createUsersRepository(db: SupabaseClient<Database>, key: Buffer): UsersRepository {
  const table = () => db.from('users');
  const touched = () => new Date().toISOString();

  async function findBy(column: 'google_id' | 'user_id', value: string): Promise<TokenColumns | null> {
    const { data, error } = await table().select(TOKEN_COLUMNS).eq(column, value).maybeSingle();
    if (error) {
      throw new DatabaseError(`users lookup by ${column}`, error);
    }
    return data;
  }

  function credentialsOf(row: TokenColumns): AccountCredentials | null {
    if (row.refresh_token === null) {
      return null;
    }
    const paired = row.access_token !== null && row.access_token_expires_at !== null;
    return {
      refreshToken: decryptToken(row.refresh_token, key),
      accessToken: paired && row.access_token ? decryptToken(row.access_token, key) : null,
      accessTokenExpiresAt: paired && row.access_token_expires_at ? new Date(row.access_token_expires_at) : null,
    };
  }

  async function update(userId: string, operation: string, values: Database['public']['Tables']['users']['Update']) {
    const { error } = await table()
      .update({ ...values, updated_at: touched() })
      .eq('user_id', userId);
    if (error) {
      throw new DatabaseError(operation, error);
    }
  }

  return {
    async upsertConnectedUser(input) {
      // Linking rules, CONTRACT.md §5.2. The unique constraints also catch races.
      const byGoogleId = await findBy('google_id', input.googleId);
      if (byGoogleId && byGoogleId.user_id !== input.userId) {
        return 'google_account_linked_elsewhere';
      }
      const byUserId = await findBy('user_id', input.userId);
      if (byUserId && byUserId.google_id !== input.googleId) {
        return 'another_google_account_linked';
      }

      const { credentials } = input;
      const paired = credentials.accessToken !== null && credentials.accessTokenExpiresAt !== null;
      const { error } = await table().upsert(
        {
          google_id: input.googleId,
          user_id: input.userId,
          email: input.email,
          scopes: input.scopes,
          refresh_token: encryptToken(credentials.refreshToken, key),
          access_token: paired && credentials.accessToken ? encryptToken(credentials.accessToken, key) : null,
          access_token_expires_at:
            paired && credentials.accessTokenExpiresAt ? credentials.accessTokenExpiresAt.toISOString() : null,
          // Re-connect forces a full sync (§4.1).
          history_id: null,
          updated_at: touched(),
        },
        { onConflict: 'google_id' },
      );
      if (error) {
        if (error.code === UNIQUE_VIOLATION) {
          return error.message.includes('user_id')
            ? 'another_google_account_linked'
            : 'google_account_linked_elsewhere';
        }
        throw new DatabaseError('users upsert', error);
      }
      return 'ok';
    },

    async getUser(userId) {
      const { data, error } = await table().select('*').eq('user_id', userId).maybeSingle();
      if (error) {
        throw new DatabaseError('users lookup', error);
      }
      return data;
    },

    async updateUserTokens(userId, tokens) {
      await update(userId, 'users token update', {
        access_token: encryptToken(tokens.accessToken, key),
        access_token_expires_at: tokens.accessTokenExpiresAt.toISOString(),
        ...(tokens.refreshToken ? { refresh_token: encryptToken(tokens.refreshToken, key) } : {}),
      });
    },

    async getUserCredentials(userId) {
      const row = await findBy('user_id', userId);
      return row ? credentialsOf(row) : null;
    },

    async findAccountByEmailUnscoped(email) {
      const { data, error } = await table().select(TOKEN_COLUMNS).eq('email', email).maybeSingle();
      if (error) {
        throw new DatabaseError('users lookup by email', error);
      }
      const credentials = data ? credentialsOf(data) : null;
      if (!data || !credentials) {
        return null;
      }
      return { userId: data.user_id, historyId: data.history_id, credentials };
    },

    async updateWatchExpiry(userId, expiresAt) {
      await update(userId, 'users watch update', { watch_expiration: expiresAt.toISOString() });
    },

    async getUserEmail(userId) {
      const { data, error } = await table().select('email').eq('user_id', userId).maybeSingle();
      if (error) {
        throw new DatabaseError('users email lookup', error);
      }
      return data?.email ?? null;
    },

    async getLastSyncedAt(userId) {
      const { data, error } = await table().select('last_synced_at').eq('user_id', userId).maybeSingle();
      if (error) {
        throw new DatabaseError('users last_synced_at lookup', error);
      }
      return data?.last_synced_at ? new Date(data.last_synced_at) : null;
    },

    async getHistoryId(userId) {
      const { data, error } = await table().select('history_id').eq('user_id', userId).maybeSingle();
      if (error) {
        throw new DatabaseError('users history_id lookup', error);
      }
      return data?.history_id ?? null;
    },

    async updateHistoryId(userId, historyId, syncedAt) {
      await update(userId, 'users history_id update', {
        history_id: historyId,
        last_synced_at: syncedAt.toISOString(),
      });
    },

    async listConnectedAccountsUnscoped({ watchExpiringBefore }) {
      const { data, error } = await table()
        .select(TOKEN_COLUMNS)
        .not('refresh_token', 'is', null)
        .or(`watch_expiration.is.null,watch_expiration.lt.${watchExpiringBefore.toISOString()}`);
      if (error) {
        throw new DatabaseError('users renewal candidates', error);
      }
      return (data ?? []).map((row) => {
        try {
          return { userId: row.user_id, credentials: credentialsOf(row) };
        } catch (decryptError) {
          if (decryptError instanceof TokenDecryptionError) {
            return { userId: row.user_id, credentials: null };
          }
          throw decryptError;
        }
      });
    },

    async clearUserTokens(userId) {
      await update(userId, 'users token clear', {
        refresh_token: null,
        access_token: null,
        access_token_expires_at: null,
      });
    },
  };
}
