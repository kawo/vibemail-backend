import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types';
import { getServiceClient } from './client';
import { keyFromEnv } from './crypto';
import { type MessagesRepository, createMessagesRepository } from './messages';
import { type UsersRepository, createUsersRepository } from './users';

/**
 * The database layer (CONTRACT.md §5). Every read and write uses the single service-role
 * Supabase client typed with the generated `Database` (src/types/database.ts). All SQL lives in
 * `src/db/`, every user-scoped query filters on `user_id` (§5.3), and OAuth tokens are encrypted
 * here and nowhere else (§5.4).
 *
 *   messages.upsertMessage(userId, message, syncedAt)  maps from/to → from_address/to_address; upsert on (user_id, gmail_id)
 *   users.getUser(userId)                              the stored users row
 *   users.updateUserTokens(userId, update)             token persistence listener target; encrypts before writing
 *   users.updateHistoryId(userId, historyId, at)       after each sync
 *   users.updateWatchExpiry(userId, expiresAt)         after a watch registration or renewal
 */
export interface Db {
  users: UsersRepository;
  messages: MessagesRepository;
}

export function createDb(
  client: SupabaseClient<Database> = getServiceClient(),
  encryptionKey: Buffer = keyFromEnv(),
): Db {
  return {
    users: createUsersRepository(client, encryptionKey),
    messages: createMessagesRepository(client),
  };
}

export { getServiceClient } from './client';
export { TokenDecryptionError, decryptToken, encryptToken, keyFromEnv } from './crypto';
export {
  type ListCursor,
  type MessageRow,
  type MessageWrite,
  type MessagesRepository,
  createMessagesRepository,
  toMessageRow,
} from './messages';
export {
  type ConnectedAccount,
  type ConnectedUserInput,
  DatabaseError,
  type RenewalCandidate,
  type UpsertResult,
  type UsersRepository,
  createUsersRepository,
} from './users';
