import { type AuthSession, type SessionIssuer, SessionError } from '../../src/services/supabaseSession';

/**
 * In-memory `SessionIssuer`: maps an ID token to a Supabase user without calling Supabase Auth.
 * Unknown tokens sign in as `defaultUser`; `fail` makes the next sign-in reject.
 */
export class FakeSessions implements SessionIssuer {
  calls: Array<{ idToken: string; accessToken: string | null }> = [];
  users = new Map<string, { userId: string; email: string | null }>();
  fail: SessionError | null = null;

  constructor(private readonly defaultUser: { userId: string; email: string | null }) {}

  async signInWithGoogleIdToken(input: { idToken: string; accessToken: string | null }): Promise<AuthSession> {
    this.calls.push(input);
    if (this.fail) {
      const error = this.fail;
      this.fail = null;
      throw error;
    }
    const user = this.users.get(input.idToken) ?? this.defaultUser;
    return {
      accessToken: `sb-access-${user.userId}`,
      refreshToken: `sb-refresh-${user.userId}`,
      expiresIn: 3600,
      expiresAt: 1_791_000_000,
      userId: user.userId,
      email: user.email,
    };
  }
}

export { SessionError };
