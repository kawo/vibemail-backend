import {
  STATE_COOKIE,
  STATE_TTL_SECONDS,
  clearStateCookie,
  issueState,
  readCookie,
  stateCookie,
  verifyState,
  verifyStateCookie,
} from '../../src/middleware/oauthState';

const SECRET = 'state-secret';
const now = new Date('2026-10-06T10:00:00.000Z');

describe('OAuth state (CONTRACT.md §4.1a)', () => {
  it('round-trips the nonce within the TTL', () => {
    const { state, nonce, expiresAt } = issueState(SECRET, now);
    expect(expiresAt.getTime() - now.getTime()).toBe(STATE_TTL_SECONDS * 1000);
    expect(verifyState(state, SECRET, new Date(now.getTime() + 60_000))).toMatchObject({ nonce });
  });

  it('uses a fresh nonce each time', () => {
    expect(issueState(SECRET, now).nonce).not.toBe(issueState(SECRET, now).nonce);
  });

  it.each([
    ['null', () => null],
    ['garbage', () => 'not-a-state'],
    ['forged payload', () => {
      const [, sig] = issueState(SECRET, now).state.split('.');
      const forged = Buffer.from(JSON.stringify({ exp: 9e9, nonce: 'attacker' })).toString('base64url');
      return `${forged}.${sig}`;
    }],
    ['wrong secret', () => issueState('other', now).state],
  ])('rejects %s', (_name, state) => {
    expect(() => verifyState(state(), SECRET, now)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });

  it('rejects an expired state', () => {
    const { state } = issueState(SECRET, now);
    expect(() => verifyState(state, SECRET, new Date(now.getTime() + STATE_TTL_SECONDS * 1000))).toThrow(/expired/);
  });
});

describe('state cookie (login-CSRF binding)', () => {
  it('is HttpOnly, Secure, SameSite=Lax, scoped to the OAuth paths, and lives as long as the state', () => {
    expect(stateCookie('abc')).toBe(
      `${STATE_COOKIE}=abc; Path=/api/v1/auth/google; Max-Age=${STATE_TTL_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(clearStateCookie()).toContain('Max-Age=0');
  });

  it('accepts only the matching nonce', () => {
    const payload = verifyState(issueState(SECRET, now).state, SECRET, now);
    expect(() => verifyStateCookie(payload, payload.nonce)).not.toThrow();
    for (const other of [null, '', 'x', `${payload.nonce}x`]) {
      expect(() => verifyStateCookie(payload, other)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    }
  });

  it('reads one cookie from the Cookie header', () => {
    const request = new Request('https://x.test', { headers: { cookie: `a=1; ${STATE_COOKIE}=n0nce; b=2` } });
    expect(readCookie(request, STATE_COOKIE)).toBe('n0nce');
    expect(readCookie(request, 'missing')).toBeNull();
    expect(readCookie(new Request('https://x.test'), STATE_COOKIE)).toBeNull();
  });
});
