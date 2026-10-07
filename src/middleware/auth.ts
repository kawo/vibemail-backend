import jwt from 'jsonwebtoken';
import { ApiError } from './errors';

/** The authenticated caller (CONTRACT.md §3.1). `userId` comes only from the token's `sub`. */
export interface AuthUser {
  userId: string;
  email: string;
}

export interface AuthConfig {
  jwtSecret: string;
  supabaseUrl: string;
}

const unauthenticated = (message: string) => new ApiError('UNAUTHENTICATED', message);

/**
 * Verifies `Authorization: Bearer <Supabase access token>` locally: HS256 only (the allow-list
 * blocks `alg: none` and algorithm confusion), audience `authenticated`, issuer
 * `${SUPABASE_URL}/auth/v1`, and expiry.
 */
export function requireUser(request: Request, config: AuthConfig): AuthUser {
  const header = request.headers.get('authorization');
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  if (!match?.[1]) {
    throw unauthenticated('missing bearer token');
  }
  let claims: string | jwt.JwtPayload;
  try {
    claims = jwt.verify(match[1], config.jwtSecret, {
      algorithms: ['HS256'],
      audience: 'authenticated',
      issuer: `${config.supabaseUrl.replace(/\/+$/, '')}/auth/v1`,
    });
  } catch {
    throw unauthenticated('invalid or expired bearer token');
  }
  if (typeof claims === 'string' || typeof claims.sub !== 'string' || !claims.sub) {
    throw unauthenticated('token has no subject');
  }
  const email = (claims as { email?: unknown }).email;
  if (typeof email !== 'string' || !email) {
    throw unauthenticated('token has no email');
  }
  return { userId: claims.sub, email };
}
