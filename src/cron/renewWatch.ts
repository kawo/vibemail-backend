import { timingSafeEqual } from 'crypto';
import type { RenewalCandidate, UsersRepository } from '../db/users';
import { ApiError } from '../middleware/errors';
import { type MailProviderFactory, ProviderError } from '../providers/provider';
import { persistTokensFor } from '../services/gmailAccount';

/**
 * Daily Gmail watch renewal, CONTRACT.md §4.6. Renews every connected account whose watch is
 * missing, expired, or expires within 24 hours. Failures are per account, never fatal for the run.
 */

export const RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;
export const RENEW_CONCURRENCY = 5;

export interface RenewDeps {
  factory: MailProviderFactory;
  users: UsersRepository;
  now?: () => Date;
  log?: (message: string, error?: unknown) => void;
}

export interface RenewResult {
  renewed: number;
  revoked: number;
  failed: number;
  durationMs: number;
}

const defaultLog = (message: string, error?: unknown): void => {
  console.error(message, error instanceof Error ? error.message : (error ?? ''));
};

/**
 * `Authorization: Bearer <CRON_SECRET>`, compared in constant time. Fails closed with
 * `INTERNAL` when the secret is not configured.
 */
export function verifyCronSecret(authorization: string | null, secret: string | undefined): void {
  if (!secret) {
    throw new ApiError('INTERNAL', 'CRON_SECRET is not configured');
  }
  const given = Buffer.from(authorization ?? '', 'utf8');
  const expected = Buffer.from(`Bearer ${secret}`, 'utf8');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new ApiError('UNAUTHENTICATED', 'invalid or missing cron secret');
  }
}

type Outcome = 'renewed' | 'revoked' | 'failed';

async function renewOne(deps: RenewDeps, candidate: RenewalCandidate, log: NonNullable<RenewDeps['log']>): Promise<Outcome> {
  if (!candidate.credentials) {
    // Undecryptable stored tokens are treated like invalid_grant (CONTRACT.md §5.4).
    await deps.users.clearUserTokens(candidate.userId);
    return 'revoked';
  }
  const provider = deps.factory.forAccount(candidate.credentials, persistTokensFor(deps.users, candidate.userId));
  try {
    const watch = await provider.watch();
    await deps.users.updateWatchExpiry(candidate.userId, watch.expiresAt);
    return 'renewed';
  } catch (error) {
    if (error instanceof ProviderError && error.kind === 'revoked') {
      await deps.users.clearUserTokens(candidate.userId);
      return 'revoked';
    }
    log('watch renewal failed for an account', error);
    return 'failed';
  }
}

export async function renewWatches(deps: RenewDeps): Promise<RenewResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? defaultLog;
  const started = now();
  const candidates = await deps.users.listConnectedAccountsUnscoped({
    watchExpiringBefore: new Date(started.getTime() + RENEW_WINDOW_MS),
  });

  const counts: Record<Outcome, number> = { renewed: 0, revoked: 0, failed: 0 };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < candidates.length) {
      const candidate = candidates[next];
      next += 1;
      if (!candidate) {
        continue;
      }
      let outcome: Outcome;
      try {
        outcome = await renewOne(deps, candidate, log);
      } catch (error) {
        // A DB failure for one account (e.g. clearing tokens) must not stop the run.
        log('watch renewal bookkeeping failed for an account', error);
        outcome = 'failed';
      }
      counts[outcome] += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(RENEW_CONCURRENCY, candidates.length) }, worker));

  return { ...counts, durationMs: now().getTime() - started.getTime() };
}
