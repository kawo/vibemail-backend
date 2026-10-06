import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccountCredentials, TokenUpdate } from '../providers/provider';
import { decryptToken, encryptToken } from './crypto';

/**
 * Repository for the `users` table (CONTRACT.md §5.2). All SQL for it lives here, every
 * user-scoped query filters on `user_id` (§5.3), and tokens are encrypted on write and
 * decrypted on read (§5.4).
 */

/**
 * Columns this repository reads. Defined locally because `src/types/` belongs to the schema
 * session and does not exist on `main`; replace with the generated row type after the merge.
 */
interface UserTokenRow {
  google_id: string;
  user_id: string;
  refresh_token: string | null;
  access_token: string | null;
  access_token_expires_at: string | null;
}

export interface ConnectedUserInput {
  googleId: string;
  userId: string;
  email: string;
  scopes: string[];
  credentials: AccountCredentials;
}

export type UpsertResult = 'ok' | 'google_account_linked_elsewhere' | 'another_google_account_linked';

export interface UsersRepository {
  upsertConnectedUser(input: ConnectedUserInput): Promise<UpsertResult>;
  /** Persists a token refresh. Writes the access token and its expiry as a pair (§3.1). */
  updateUserTokens(userId: string, update: TokenUpdate): Promise<void>;
  /** Decrypted credentials, or null when the user has no row or no refresh token. */
  getUserCredentials(userId: string): Promise<AccountCredentials | null>;
  updateWatch(userId: string, expiresAt: Date): Promise<void>;
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

export function createUsersRepository(db: SupabaseClient, key: Buffer): UsersRepository {
  const table = () => db.from('users');

  async function findBy(column: 'google_id' | 'user_id', value: string): Promise<UserTokenRow | null> {
    const { data, error } = await table()
      .select('google_id, user_id, refresh_token, access_token, access_token_expires_at')
      .eq(column, value)
      .maybeSingle()
      .overrideTypes<UserTokenRow | null, { merge: false }>();
    if (error) {
      throw new DatabaseError(`users lookup by ${column}`, error);
    }
    return data;
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
      const { error } = await table().upsert(
        {
          google_id: input.googleId,
          user_id: input.userId,
          email: input.email,
          scopes: input.scopes,
          refresh_token: encryptToken(credentials.refreshToken, key),
          access_token:
            credentials.accessToken && credentials.accessTokenExpiresAt
              ? encryptToken(credentials.accessToken, key)
              : null,
          access_token_expires_at:
            credentials.accessToken && credentials.accessTokenExpiresAt
              ? credentials.accessTokenExpiresAt.toISOString()
              : null,
          // Re-connect forces a full sync (§4.1).
          last_history_id: null,
          updated_at: new Date().toISOString(),
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

    async updateUserTokens(userId, update) {
      const { error } = await table()
        .update({
          access_token: encryptToken(update.accessToken, key),
          access_token_expires_at: update.accessTokenExpiresAt.toISOString(),
          ...(update.refreshToken ? { refresh_token: encryptToken(update.refreshToken, key) } : {}),
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
      if (error) {
        throw new DatabaseError('users token update', error);
      }
    },

    async getUserCredentials(userId) {
      const row = await findBy('user_id', userId);
      if (!row || row.refresh_token === null) {
        return null;
      }
      const paired = row.access_token !== null && row.access_token_expires_at !== null;
      return {
        refreshToken: decryptToken(row.refresh_token, key),
        accessToken: paired && row.access_token ? decryptToken(row.access_token, key) : null,
        accessTokenExpiresAt: paired && row.access_token_expires_at ? new Date(row.access_token_expires_at) : null,
      };
    },

    async updateWatch(userId, expiresAt) {
      const { error } = await table()
        .update({ watch_expiration: expiresAt.toISOString(), updated_at: new Date().toISOString() })
        .eq('user_id', userId);
      if (error) {
        throw new DatabaseError('users watch update', error);
      }
    },

    async clearUserTokens(userId) {
      const { error } = await table()
        .update({
          refresh_token: null,
          access_token: null,
          access_token_expires_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
      if (error) {
        throw new DatabaseError('users token clear', error);
      }
    },
  };
}
