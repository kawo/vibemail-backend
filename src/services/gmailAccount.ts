import { ApiError } from '../middleware/errors';
import type { MessagesRepository } from '../db/messages';
import type { UsersRepository } from '../db/users';
import { runInitialSync } from '../sync';
import { TokenDecryptionError } from '../db/crypto';
import {
  type MailProvider,
  type MailProviderFactory,
  type OnTokens,
  type TokenUpdate,
  type VerifiedGrant,
  ProviderError,
} from '../providers/provider';
import { REQUIRED_GMAIL_SCOPES } from '../providers/gmail/auth';
import { type AuthSession, type SessionIssuer, SessionError } from './supabaseSession';

export interface GmailAccountDeps {
  factory: MailProviderFactory;
  users: UsersRepository;
  messages: MessagesRepository;
  log?: (message: string, error: unknown) => void;
}

export interface SignInDeps extends GmailAccountDeps {
  sessions: SessionIssuer;
}

export interface SignInResult {
  /** The Supabase session for the signed-in user, handed to the frontend. */
  session: AuthSession;
  email: string;
  scopes: string[];
  /** Null when `watch()` failed; the failure is logged, not returned (CONTRACT.md §4.1b step 7). */
  watchExpiration: Date | null;
  /** Step 8. On failure `history_id` stays null, so the next push notification runs the full sync. */
  initialSync: 'completed' | 'failed';
}

const defaultLog = (message: string, error: unknown): void => {
  console.error(message, error instanceof Error ? error.message : error);
};

/** Maps a provider failure to its §3.3 code. */
export function apiErrorFromProvider(error: ProviderError): ApiError {
  switch (error.kind) {
    case 'revoked':
      return new ApiError('GMAIL_TOKEN_REVOKED', 'Google access was revoked; reconnect Gmail');
    case 'rate_limited':
      return new ApiError('GMAIL_RATE_LIMITED', 'Google rate limit reached', {
        ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      });
    default:
      return new ApiError('GMAIL_UPSTREAM_ERROR', 'Google request failed');
  }
}

/** The persistence hook: every refresh is written to `users` immediately. */
export function persistTokensFor(users: UsersRepository, userId: string): OnTokens {
  return (update: TokenUpdate) => users.updateUserTokens(userId, update);
}

function checkGrant(grant: VerifiedGrant): { googleId: string; email: string; idToken: string } {
  if (!grant.credentials.refreshToken) {
    throw new ApiError('GMAIL_NOT_CONNECTED', 'Google returned no refresh token', {
      details: { reason: 'no_refresh_token' },
    });
  }
  if (!grant.email || !grant.accountId) {
    throw new ApiError('GMAIL_NOT_CONNECTED', 'The email scope was not granted', {
      details: { reason: 'missing_email_scope', missingScopes: ['email'] },
    });
  }
  if (!grant.idToken) {
    throw new ApiError('GMAIL_NOT_CONNECTED', 'Google returned no ID token', {
      details: { reason: 'missing_openid_scope', missingScopes: ['openid'] },
    });
  }
  const missingScopes = REQUIRED_GMAIL_SCOPES.filter((scope) => !grant.scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new ApiError('GMAIL_NOT_CONNECTED', 'Required Gmail scopes were not granted', {
      details: { reason: 'missing_gmail_scope', missingScopes },
    });
  }
  return { googleId: grant.accountId, email: grant.email, idToken: grant.idToken };
}

/**
 * Google sign-in, CONTRACT.md §4.1b steps 3–8: exchange the authorization code, check identity
 * and scopes, sign in to Supabase with the ID token (creating the user on first sign-in), store
 * encrypted Gmail tokens (upsert on `google_id`), register the push watch, then run the initial
 * full sync. Watch and sync failures are logged and never fail the sign-in.
 */
export async function signInWithGoogle(deps: SignInDeps, input: { code: string }): Promise<SignInResult> {
  const log = deps.log ?? defaultLog;

  let grant: VerifiedGrant;
  try {
    grant = await deps.factory.exchangeAuthorizationCode(input.code);
  } catch (error) {
    throw error instanceof ProviderError ? apiErrorFromProvider(error) : error;
  }
  const { googleId, email, idToken } = checkGrant(grant);

  let session: AuthSession;
  try {
    session = await deps.sessions.signInWithGoogleIdToken({ idToken, accessToken: grant.credentials.accessToken });
  } catch (error) {
    if (error instanceof SessionError) {
      log('Supabase sign-in failed', error);
      throw new ApiError('INTERNAL', 'Sign-in failed', { details: { reason: 'SUPABASE_SIGN_IN_FAILED' } });
    }
    throw error;
  }
  // Both come from the same Google account; a mismatch means a broken provider setup.
  if (session.email && session.email.toLowerCase() !== email.toLowerCase()) {
    throw new ApiError('VALIDATION_FAILED', 'The Google account does not match the Supabase user', {
      details: { reason: 'EMAIL_MISMATCH' },
    });
  }
  const userId = session.userId;

  const outcome = await deps.users.upsertConnectedUser({
    googleId,
    userId,
    email,
    name: grant.name,
    scopes: grant.scopes,
    credentials: grant.credentials,
  });
  if (outcome === 'google_account_linked_elsewhere') {
    throw new ApiError('VALIDATION_FAILED', 'This Google account is linked to another user', {
      details: { reason: 'GOOGLE_ACCOUNT_LINKED_ELSEWHERE' },
    });
  }
  if (outcome === 'another_google_account_linked') {
    throw new ApiError('VALIDATION_FAILED', 'Another Google account is already connected', {
      details: { reason: 'ANOTHER_GOOGLE_ACCOUNT_LINKED' },
    });
  }

  const provider = deps.factory.forAccount(grant.credentials, persistTokensFor(deps.users, userId));

  let watchExpiration: Date | null = null;
  try {
    const watch = await provider.watch();
    await deps.users.updateWatchExpiry(userId, watch.expiresAt);
    watchExpiration = watch.expiresAt;
  } catch (error) {
    log('watch registration failed after sign-in', error);
  }

  let initialSync: SignInResult['initialSync'] = 'completed';
  try {
    await runInitialSync({ provider, factory: deps.factory, messages: deps.messages, users: deps.users }, userId);
  } catch (error) {
    initialSync = 'failed';
    log('initial sync failed after sign-in', error);
  }

  return { session, email, scopes: grant.scopes, watchExpiration, initialSync };
}

/**
 * A provider for a stored account: decrypts its credentials and wires the persistence hook.
 * Throws `GMAIL_NOT_CONNECTED` without a usable row, and `GMAIL_TOKEN_REVOKED` when the stored
 * value cannot be decrypted (CONTRACT.md §5.4).
 */
export async function providerForUser(deps: GmailAccountDeps, userId: string): Promise<MailProvider> {
  let credentials;
  try {
    credentials = await deps.users.getUserCredentials(userId);
  } catch (error) {
    if (error instanceof TokenDecryptionError) {
      throw new ApiError('GMAIL_TOKEN_REVOKED', 'Stored Google credentials are unreadable; reconnect Gmail');
    }
    throw error;
  }
  if (!credentials) {
    throw new ApiError('GMAIL_NOT_CONNECTED', 'Gmail is not connected');
  }
  return deps.factory.forAccount(credentials, persistTokensFor(deps.users, userId));
}

/**
 * Refreshes a stored account's access token: reads and decrypts the stored refresh token,
 * refreshes, and persists the result before returning. On revocation, clears the stored tokens.
 */
export async function refreshUserAccessToken(deps: GmailAccountDeps, userId: string): Promise<TokenUpdate> {
  const provider = await providerForUser(deps, userId);
  try {
    return await provider.refreshAccessToken();
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.kind === 'revoked') {
        await deps.users.clearUserTokens(userId);
      }
      throw apiErrorFromProvider(error);
    }
    throw error;
  }
}
