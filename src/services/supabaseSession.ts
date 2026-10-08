import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types';

/** A Supabase Auth session for the signed-in user, handed to the frontend (CONTRACT.md §4.1b). */
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  /** Seconds until `accessToken` expires. */
  expiresIn: number;
  /** Epoch seconds. */
  expiresAt: number;
  userId: string;
  email: string | null;
}

/** Supabase rejected the sign-in (e.g. the Google provider is not enabled). Maps to `500 INTERNAL`. */
export class SessionError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'SessionError';
    this.cause = cause;
  }
}

export interface SessionIssuer {
  /**
   * Signs in (creating the user on first sign-in) with a Google ID token. `accessToken` is
   * checked against the token's `at_hash` claim.
   */
  signInWithGoogleIdToken(input: { idToken: string; accessToken: string | null }): Promise<AuthSession>;
}

/**
 * `auth.signInWithIdToken` on a throwaway client: signing in stores the user's session on the
 * client, so it must never be the shared service-role DB client (CONTRACT.md §5.3).
 */
export function createSupabaseSessionIssuer(url: string, serviceRoleKey: string): SessionIssuer {
  return {
    async signInWithGoogleIdToken({ idToken, accessToken }) {
      const client = createClient<Database>(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { data, error } = await client.auth.signInWithIdToken({
        provider: 'google',
        token: idToken,
        ...(accessToken ? { access_token: accessToken } : {}),
      });
      if (error || !data.session || !data.user) {
        throw new SessionError(`Supabase sign-in failed: ${error?.message ?? 'no session returned'}`, error);
      }
      const { session, user } = data;
      return {
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        expiresIn: session.expires_in,
        expiresAt: session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in,
        userId: user.id,
        email: user.email ?? null,
      };
    },
  };
}
