import { STATE_TTL_SECONDS, issueState, verifyState } from '../../src/middleware/oauthState';

const SECRET = 'state-secret';
const now = new Date('2026-10-06T10:00:00.000Z');

describe('OAuth state (CONTRACT.md §4.1a)', () => {
  it('round-trips the user within the TTL', () => {
    const { state, expiresAt } = issueState({ sub: 'u1', email: 'me@example.com' }, SECRET, now);
    expect(expiresAt.getTime() - now.getTime()).toBe(STATE_TTL_SECONDS * 1000);
    expect(verifyState(state, SECRET, new Date(now.getTime() + 60_000))).toMatchObject({ sub: 'u1', email: 'me@example.com' });
  });

  it('uses a fresh nonce each time', () => {
    const a = issueState({ sub: 'u1', email: 'e' }, SECRET, now).state;
    const b = issueState({ sub: 'u1', email: 'e' }, SECRET, now).state;
    expect(a).not.toBe(b);
  });

  it.each([
    ['null', () => null],
    ['garbage', () => 'not-a-state'],
    ['forged payload', () => {
      const [, sig] = issueState({ sub: 'u1', email: 'e' }, SECRET, now).state.split('.');
      const forged = Buffer.from(JSON.stringify({ sub: 'attacker', email: 'e', exp: 9e9, nonce: 'n' })).toString('base64url');
      return `${forged}.${sig}`;
    }],
    ['wrong secret', () => issueState({ sub: 'u1', email: 'e' }, 'other', now).state],
  ])('rejects %s', (_name, state) => {
    expect(() => verifyState(state(), SECRET, now)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });

  it('rejects an expired state', () => {
    const { state } = issueState({ sub: 'u1', email: 'e' }, SECRET, now);
    expect(() => verifyState(state, SECRET, new Date(now.getTime() + STATE_TTL_SECONDS * 1000))).toThrow(/expired/);
  });
});
