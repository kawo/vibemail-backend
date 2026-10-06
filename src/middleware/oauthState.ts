import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { ApiError } from './errors';

/**
 * Signed OAuth `state` (CONTRACT.md §4.1a): `base64url(payload).base64url(HMAC-SHA256)`.
 * It binds Google's browser redirect to the Supabase user who started the flow.
 */

export const STATE_TTL_SECONDS = 600;

export interface StatePayload {
  sub: string;
  email: string;
  /** Expiry, epoch seconds. */
  exp: number;
  nonce: string;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueState(
  user: { sub: string; email: string },
  secret: string,
  now: Date = new Date(),
): { state: string; expiresAt: Date } {
  const exp = Math.floor(now.getTime() / 1000) + STATE_TTL_SECONDS;
  const payload: StatePayload = { sub: user.sub, email: user.email, exp, nonce: randomBytes(16).toString('base64url') };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { state: `${encoded}.${sign(encoded, secret)}`, expiresAt: new Date(exp * 1000) };
}

/** Verifies the signature in constant time and the expiry. Throws `UNAUTHENTICATED` on any failure. */
export function verifyState(state: string | null, secret: string, now: Date = new Date()): StatePayload {
  const invalid = () => new ApiError('UNAUTHENTICATED', 'invalid or expired OAuth state');
  const [encoded, signature, extra] = (state ?? '').split('.');
  if (!encoded || !signature || extra !== undefined) {
    throw invalid();
  }
  const expected = Buffer.from(sign(encoded, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw invalid();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const p = payload as Partial<StatePayload>;
  if (
    typeof p.sub !== 'string' ||
    typeof p.email !== 'string' ||
    typeof p.exp !== 'number' ||
    typeof p.nonce !== 'string' ||
    p.exp * 1000 <= now.getTime()
  ) {
    throw invalid();
  }
  return { sub: p.sub, email: p.email, exp: p.exp, nonce: p.nonce };
}
