import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { ApiError } from './errors';

/**
 * Signed OAuth `state` for Google sign-in (CONTRACT.md §4.1a): `base64url(payload).base64url(HMAC-SHA256)`.
 * No user exists yet, so the state is bound to the browser instead: its `nonce` is also set in a
 * short-lived HttpOnly cookie, and the callback requires both to match (login-CSRF defence).
 */

export const STATE_TTL_SECONDS = 600;
export const STATE_COOKIE = 'vibemail_oauth_state';
/** Covers both `/api/v1/auth/google` and `/api/v1/auth/google/callback`. */
const STATE_COOKIE_PATH = '/api/v1/auth/google';

export interface StatePayload {
  /** Expiry, epoch seconds. */
  exp: number;
  nonce: string;
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function equalInConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function issueState(secret: string, now: Date = new Date()): { state: string; nonce: string; expiresAt: Date } {
  const exp = Math.floor(now.getTime() / 1000) + STATE_TTL_SECONDS;
  const payload: StatePayload = { exp, nonce: randomBytes(16).toString('base64url') };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return { state: `${encoded}.${sign(encoded, secret)}`, nonce: payload.nonce, expiresAt: new Date(exp * 1000) };
}

/** Verifies the signature in constant time and the expiry. Throws `UNAUTHENTICATED` on any failure. */
export function verifyState(state: string | null, secret: string, now: Date = new Date()): StatePayload {
  const invalid = () => new ApiError('UNAUTHENTICATED', 'invalid or expired OAuth state');
  const [encoded, signature, extra] = (state ?? '').split('.');
  if (!encoded || !signature || extra !== undefined) {
    throw invalid();
  }
  if (!equalInConstantTime(sign(encoded, secret), signature)) {
    throw invalid();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const p = payload as Partial<StatePayload>;
  if (typeof p.exp !== 'number' || typeof p.nonce !== 'string' || p.exp * 1000 <= now.getTime()) {
    throw invalid();
  }
  return { exp: p.exp, nonce: p.nonce };
}

/** The state must come back in the same browser that started the flow. Throws `UNAUTHENTICATED`. */
export function verifyStateCookie(payload: StatePayload, cookieNonce: string | null): void {
  if (!cookieNonce || !equalInConstantTime(payload.nonce, cookieNonce)) {
    throw new ApiError('UNAUTHENTICATED', 'OAuth state does not belong to this browser');
  }
}

export function stateCookie(nonce: string): string {
  return `${STATE_COOKIE}=${nonce}; Path=${STATE_COOKIE_PATH}; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearStateCookie(): string {
  return `${STATE_COOKIE}=; Path=${STATE_COOKIE_PATH}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** One cookie's value from the `Cookie` header, or null. */
export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim() || null;
    }
  }
  return null;
}
