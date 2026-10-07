import { randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptToken, encryptToken } from '../../src/db/crypto';
import { createUsersRepository } from '../../src/db/users';

type Row = Record<string, unknown>;
interface Op {
  kind: 'select' | 'upsert' | 'update';
  values?: Row;
  filters: Array<[string, unknown]>;
  onConflict?: string;
}

/** Minimal recording stand-in for the PostgREST builder chain used by src/db/users.ts. */
function fakeDb(rows: Row[], upsertError: { code: string; message: string } | null = null) {
  const ops: Op[] = [];
  const builder = (op: Op) => {
    const match = () => rows.find((r) => op.filters.every(([k, v]) => r[k] === v)) ?? null;
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        op.filters.push([column, value]);
        return chain;
      },
      maybeSingle: () => chain,
      overrideTypes: async () => ({ data: match(), error: null }),
      then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
    };
    return chain;
  };
  const db = {
    from: () => ({
      select: () => {
        const op: Op = { kind: 'select', filters: [] };
        ops.push(op);
        return builder(op);
      },
      upsert: async (values: Row, options: { onConflict: string }) => {
        ops.push({ kind: 'upsert', values, filters: [], onConflict: options.onConflict });
        return { error: upsertError };
      },
      update: (values: Row) => {
        const op: Op = { kind: 'update', values, filters: [] };
        ops.push(op);
        return builder(op);
      },
    }),
  };
  return { db: db as unknown as SupabaseClient, ops };
}

const key = randomBytes(32);
const expires = new Date('2026-10-06T13:00:00.000Z');
const input = {
  googleId: 'google-123',
  userId: 'user-1',
  email: 'me@example.com',
  scopes: ['s'],
  credentials: { refreshToken: 'refresh-plain', accessToken: 'access-plain', accessTokenExpiresAt: expires },
};

describe('users repository (CONTRACT.md §5.2–§5.4)', () => {
  it('upserts on google_id with encrypted tokens and a reset sync cursor', async () => {
    const { db, ops } = fakeDb([]);
    await expect(createUsersRepository(db, key).upsertConnectedUser(input)).resolves.toBe('ok');
    const upsert = ops.find((o) => o.kind === 'upsert');
    expect(upsert?.onConflict).toBe('google_id');
    const values = upsert?.values ?? {};
    expect(values).toMatchObject({ google_id: 'google-123', user_id: 'user-1', history_id: null });
    expect(values.refresh_token).not.toBe('refresh-plain');
    expect(decryptToken(String(values.refresh_token), key)).toBe('refresh-plain');
    expect(decryptToken(String(values.access_token), key)).toBe('access-plain');
    expect(values.access_token_expires_at).toBe(expires.toISOString());
  });

  it('refuses a Google account linked to another user, and a second account for this user', async () => {
    const elsewhere = fakeDb([{ google_id: 'google-123', user_id: 'user-2' }]);
    await expect(createUsersRepository(elsewhere.db, key).upsertConnectedUser(input)).resolves.toBe(
      'google_account_linked_elsewhere',
    );
    const second = fakeDb([{ google_id: 'google-999', user_id: 'user-1' }]);
    await expect(createUsersRepository(second.db, key).upsertConnectedUser(input)).resolves.toBe(
      'another_google_account_linked',
    );
    expect([...elsewhere.ops, ...second.ops].some((o) => o.kind === 'upsert')).toBe(false);
  });

  it('maps a unique violation on user_id during a race', async () => {
    const { db } = fakeDb([], { code: '23505', message: 'duplicate key value violates "users_user_id_key"' });
    await expect(createUsersRepository(db, key).upsertConnectedUser(input)).resolves.toBe(
      'another_google_account_linked',
    );
  });

  it('updateUserTokens encrypts, pairs the expiry, and is scoped by user_id', async () => {
    const { db, ops } = fakeDb([]);
    const repo = createUsersRepository(db, key);
    await repo.updateUserTokens('user-1', { accessToken: 'new-access', accessTokenExpiresAt: expires });
    await repo.updateUserTokens('user-1', {
      accessToken: 'a2',
      accessTokenExpiresAt: expires,
      refreshToken: 'rotated',
    });
    const [first, second] = ops.filter((o) => o.kind === 'update');
    expect(first?.filters).toEqual([['user_id', 'user-1']]);
    expect(decryptToken(String(first?.values?.access_token), key)).toBe('new-access');
    expect(first?.values?.access_token_expires_at).toBe(expires.toISOString());
    expect(first?.values).not.toHaveProperty('refresh_token');
    expect(decryptToken(String(second?.values?.refresh_token), key)).toBe('rotated');
  });

  it('getUserCredentials decrypts and drops an unpaired access token', async () => {
    const { db, ops } = fakeDb([
      {
        google_id: 'g',
        user_id: 'user-1',
        refresh_token: encryptToken('r', key),
        access_token: encryptToken('a', key),
        access_token_expires_at: null,
      },
    ]);
    await expect(createUsersRepository(db, key).getUserCredentials('user-1')).resolves.toEqual({
      refreshToken: 'r',
      accessToken: null,
      accessTokenExpiresAt: null,
    });
    expect(ops[0]?.filters).toEqual([['user_id', 'user-1']]);
  });

  it('returns null for a revoked or missing account, and clears tokens by user_id', async () => {
    const { db, ops } = fakeDb([{ google_id: 'g', user_id: 'user-1', refresh_token: null }]);
    const repo = createUsersRepository(db, key);
    await expect(repo.getUserCredentials('user-1')).resolves.toBeNull();
    await expect(repo.getUserCredentials('nobody')).resolves.toBeNull();
    await repo.clearUserTokens('user-1');
    const clear = ops.find((o) => o.kind === 'update');
    expect(clear?.values).toMatchObject({ refresh_token: null, access_token: null, access_token_expires_at: null });
    expect(clear?.filters).toEqual([['user_id', 'user-1']]);
  });
});
