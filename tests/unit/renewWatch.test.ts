import { RENEW_WINDOW_MS, renewWatches, verifyCronSecret } from '../../src/cron/renewWatch';
import { ProviderError } from '../../src/providers/provider';
import { createFakeProviderFactory } from '../fakes/fakeProvider';
import { MemoryUsers } from '../fakes/memoryRepos';

const now = new Date('2026-10-06T06:00:00.000Z');
const hours = (h: number) => new Date(now.getTime() + h * 3600_000);

function setup(watches: Record<string, Date | undefined>) {
  const { factory, box } = createFakeProviderFactory();
  const users = new MemoryUsers();
  for (const [userId, watch] of Object.entries(watches)) {
    users.rows.set(userId, {
      googleId: `g-${userId}`,
      userId,
      email: `${userId}@example.com`,
      scopes: [],
      credentials: { refreshToken: `r-${userId}`, accessToken: null, accessTokenExpiresAt: null },
      historyId: '1',
      lastSyncedAt: null,
      ...(watch ? { watch } : {}),
    });
  }
  const log = jest.fn();
  return { deps: { factory, users, now: () => now, log }, box, users, log };
}

describe('renewWatches (CONTRACT.md §4.6)', () => {
  it('renews missing, expired and expiring-within-24h watches, and skips the rest', async () => {
    const { deps, box, users } = setup({
      none: undefined,
      expired: hours(-5),
      soon: hours(23),
      later: hours(25),
      week: hours(24 * 6),
    });
    const result = await renewWatches(deps);
    expect(result).toEqual({ renewed: 3, revoked: 0, failed: 0, durationMs: 0 });
    expect(box.calls.filter((c) => c.method === 'watch')).toHaveLength(3);
    for (const userId of ['none', 'expired', 'soon']) {
      expect(users.rows.get(userId)?.watch?.getTime()).toBeGreaterThan(now.getTime() + RENEW_WINDOW_MS);
    }
    expect(users.rows.get('later')?.watch).toEqual(hours(25));
  });

  it('isolates per-account failures: revoked accounts are cleared, others counted as failed', async () => {
    const { deps, box, users, log } = setup({ a: undefined, b: undefined, c: undefined });
    let call = 0;
    box.failNext.set('watch', new ProviderError('revoked', 'invalid_grant'));
    jest.spyOn(deps.factory, 'forAccount').mockImplementation((credentials, onTokens) => {
      call += 1;
      const provider = createFakeProviderFactory(box).factory.forAccount(credentials, onTokens);
      if (call === 2) {
        jest.spyOn(provider, 'watch').mockRejectedValue(new ProviderError('rate_limited', 'slow'));
      }
      return provider;
    });
    const result = await renewWatches(deps);
    expect(result).toMatchObject({ renewed: 1, revoked: 1, failed: 1 });
    expect(users.cleared).toHaveLength(1);
    expect(log).toHaveBeenCalledWith('watch renewal failed for an account', expect.any(ProviderError));
  });

  it('treats undecryptable stored tokens as revoked, with no Gmail call', async () => {
    const { deps, box, users } = setup({ a: undefined });
    users.undecryptable.add('a');
    box.forbidCalls = true;
    await expect(renewWatches(deps)).resolves.toMatchObject({ renewed: 0, revoked: 1, failed: 0 });
    expect(users.cleared).toEqual(['a']);
  });

  it('never runs more than 5 renewals at once', async () => {
    const watches = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`u${i}`, undefined]));
    const { deps } = setup(watches);
    let active = 0;
    let peak = 0;
    const real = deps.factory.forAccount.bind(deps.factory);
    jest.spyOn(deps.factory, 'forAccount').mockImplementation((credentials, onTokens) => {
      const provider = real(credentials, onTokens);
      const watch = provider.watch.bind(provider);
      jest.spyOn(provider, 'watch').mockImplementation(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return watch();
      });
      return provider;
    });
    await expect(renewWatches(deps)).resolves.toMatchObject({ renewed: 12 });
    expect(peak).toBeLessThanOrEqual(5);
    expect(peak).toBeGreaterThan(1);
  });
});

describe('verifyCronSecret', () => {
  const secret = 's'.repeat(32);
  it('accepts the exact bearer and rejects anything else', () => {
    expect(() => verifyCronSecret(`Bearer ${secret}`, secret)).not.toThrow();
    expect(() => verifyCronSecret(`Bearer ${'x'.repeat(32)}`, secret)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
    expect(() => verifyCronSecret(null, secret)).toThrow(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });
  it('fails closed when CRON_SECRET is not configured', () => {
    expect(() => verifyCronSecret(`Bearer ${secret}`, undefined)).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
    expect(() => verifyCronSecret('Bearer ', '')).toThrow(expect.objectContaining({ code: 'INTERNAL' }));
  });
});
