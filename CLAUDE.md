# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

VibeMail Engine is a data-liberation sync engine. It extracts a user's Gmail data via OAuth2 into Supabase and exposes it through a REST API at `/api/v1`, deployed as Vercel serverless functions.

Two documents are binding; read them before any change:
- **`CONTRACT.md`**: scope, acceptance criteria (§2), auth (§3.1), error envelope (§3.3), sync procedure (§3.5), endpoint contracts (§4), data model (§5), tenant isolation (§5.3), two-session rule (§6).
- **`BUILD_SEQUENCE.md`**: eight atomic build units in order. Each unit's **Verified** check must pass before the next starts.

Any change to an endpoint, an `ErrorCode` or a stored field goes into `CONTRACT.md` first, in the same change (§7).

## Stack

- **Runtime and language:** Node.js and TypeScript in strict mode. TypeScript is **pinned to 6.x**, because `ts-jest` does not support 7.
- **Gmail:** `googleapis` (183.x) with `google-auth-library` 11.x.
  - Construct clients only as `new OAuth2Client({ clientId, clientSecret, redirectUri })`; the positional form is deprecated.
  - Detect revocation by `GaxiosError` with `response.data.error === 'invalid_grant'`.
  - `users.watch` uses `labelFilterBehavior: 'INCLUDE'`; `labelFilterAction` is deprecated and ignored when the newer field is set.
- **Database:** the Supabase JS client, using a single service-role client. There is no anon key.
- **Auth tokens:** `jsonwebtoken` verifies Supabase access tokens.
- **Tests:** Jest via `ts-jest`, plus `supertest`. `supertest` needs a small adapter, because the handlers take a Web `Request` rather than a Node `http.Server`.
- **Deployment:** Vercel Functions under top-level `api/`, with no framework. Each file exports `GET`/`POST(request: Request): Promise<Response>` on the Node.js runtime (never Edge). `vercel.json` holds the cron job, the per-function `maxDuration`, and the `/webhook/gmail` rewrite.
- **Two tsconfigs.** `tsconfig.json` keeps `rootDir: ./src` while also including `api/`, so plain `tsc` fails with TS6059. Never run bare `tsc`; Vercel compiles `api/` itself.
  - **Type-checking:** always via `tsconfig.check.json`, which extends the base config with `rootDir: "."`, `noEmit`, `tests/`, and `types: ["node", "jest"]`. TypeScript 6 no longer loads `@types/*` packages automatically.
  - **Target is ES2020:** there is no `Error.cause` or other ES2022 library API. Declare such fields explicitly (see `ProviderError`).
  - **Jest:** `jest.config.js` (CommonJS; a `.ts` config fails to load as an ES module) points ts-jest at `tsconfig.check.json`.
- **Blocked install scripts:** npm blocked them for `esbuild`, `unrs-resolver` and `@parcel/watcher`. If `vercel dev` or Jest resolution fails, check `npm install-scripts ls`.

## Commands

```bash
npm test                            # jest --ci --runInBand
npx jest tests/unit/foo.test.ts     # single file
npx jest -t "name of test"          # single test by name
npm run typecheck                   # tsc -p tsconfig.check.json (src/, api/, tests/); `npm run build` runs the same
npm run dev                         # vercel dev: local preview of api/
supabase start                      # local Postgres/Auth for integration tests
supabase db reset                   # re-apply supabase/migrations
npm run db:types                    # schema session only: regenerate src/types/database.ts from the linked project
npm run db:push                     # pushes migrations to the hosted project; only after Gate 1 (CONTRACT.md §6)
```

`--runInBand` is required because the integration tests share one local database. A run counts as passing only when `numFailedTests`, `numPendingTests` and `numTodoTests` are all 0 in `--json` output. A leftover `.only` surfaces as pending tests.

## The two-session architecture

| Session | Branch | Owns | Never writes |
|---|---|---|---|
| Server logic | `main` | `api/`, `src/` except `src/types/` (including `src/db/`), `tests/`, `vercel.json`, `package.json` | `supabase/migrations/`, `src/types/` |
| Schema | `schema` | `supabase/migrations/`, `src/types/` | everything else, especially `src/db/` |

Migrations live in `supabase/migrations/`, because that is the only directory the Supabase CLI applies.

Server code imports from `src/types/`, which exists only on `schema` until the merge. So `main` on its own does not typecheck. All verification runs in a throwaway worktree with `schema` merged into `main` (CONTRACT.md §6 has the exact commands).

## Sequencing rule

**The schema session cannot be merged until the server-logic tests pass.** `npm test` must exit 0, and `npm run typecheck` and lint must be clean, in the Gate 1 worktree, on the current tips of both branches.

The order is:
1. The schema session drafts the schema and pushes it unmerged.
2. The server session builds every unit and passes Gate 1.
3. The schema session reviews against CONTRACT.md §5 and only then merges.

With the Supabase GitHub integration, merging into `main` runs the migration on production.

## Never-do rules

- **Never use `any`** as a TypeScript type.
- **Never poll the Gmail API for new messages.** Use Pub/Sub push webhooks. Gmail is read only by the initial full sync at connect time and by the webhook (CONTRACT.md §3.5). `GET /api/v1/messages` reads the DB only.
- **Never store OAuth tokens in plaintext.** `refresh_token` and `access_token` are encrypted with AES-256-GCM using `ENCRYPTION_KEY`, in `src/db/` only (CONTRACT.md §5.4).
- **Never make Gmail API calls without the `googleapis` `OAuth2` client.** It handles token refresh automatically. Its `'tokens'` listener persists `access_token` and `access_token_expires_at` as a pair; a missing `expiry_date` makes the library treat a token as never-expiring.
- **Never write to `src/db/` from the schema session.**
- **Never merge the schema session before `npm test` exits 0.**
- **Never hardcode credentials.** All secrets come from env. The full list is in CONTRACT.md §3.6, and the template is `.env.example`.

## Coding conventions

- **Errors:** every error response uses the CONTRACT.md §3.3 envelope `{ error: { code, message, retryable, details? } }`, with the closed `ErrorCode` union. Do not add codes without updating §3.3.
- **Pagination:** every list endpoint uses cursor-based pagination. The cursor is opaque base64url keyset `(internal_date DESC, gmail_id DESC)`, and responses return `nextCursor`. No offsets.
- **Paths:** every client endpoint lives under `/api/v1`.
- **Auth:** JWT Bearer auth on every `/api/v1` endpoint except `GET /api/v1/auth/google/callback`. That one is Google's browser redirect, authenticated by the HMAC-signed `state` issued by the bearer-protected `GET /api/v1/auth/google/start` (CONTRACT.md §4.1). The backend runs Google's code flow itself.
  - Tokens are verified with `jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], audience: 'authenticated', issuer: SUPABASE_URL + '/auth/v1' })`. The algorithm allow-list is mandatory.
  - `userId` comes only from the token's `sub`.
- **Machine endpoints** are outside `/api/v1` and don't use the user JWT:
  - The Pub/Sub webhook is at **`/webhook/gmail`**, implemented in `api/webhook/gmail.ts` and reached through a `vercel.json` rewrite. It authenticates with a `?token=` query parameter equal to `GOOGLE_PUBSUB_VERIFICATION_TOKEN`, compared in constant time.
  - The cron job is at `/api/cron/renew-watch` and authenticates with the `CRON_SECRET` bearer.
- **Account table:** `users`, keyed by `google_id` (the token-info `sub`), with a unique `user_id` linking it to the Supabase user. The connect upsert is `ON CONFLICT (google_id)` guarded by `user_id` (CONTRACT.md §5.2).
- **Tenant isolation:** the service-role client bypasses RLS, so every user-scoped query lives in `src/db/` and filters on `user_id`.
  - Only `findAccountByEmailUnscoped` (webhook) and `listConnectedAccountsUnscoped({ watchExpiringBefore })` (cron) may skip that filter.
  - RLS is enabled with no policies, which closes the public Data API.
- **History records carry only IDs:** label changes are deltas, applied to stored `label_ids`; an unknown message is fetched and stored; a 404 on `get` is skipped (CONTRACT.md §3.5).
- **Sync state:** sync starts from the **stored** `history_id`, never from a notification's `historyId`. That value only advances, under a per-user advisory lock. A `history.list` 404 falls back to a full sync of the 50 newest messages.
- **Webhook responses:** the webhook verifies the token and decodes the body, then returns `200` at once and runs the sync inside `waitUntil` (`@vercel/functions`). Background failures are logged, not retried. Never move sync work before the ack.
- **Send:** the input is `{ to, subject, body, threadId? }`. `threadId` is passed to Gmail unchanged; no reply headers are derived. The sent message is fetched back with `messages.get`, because `messages.send` returns only `id`, `threadId` and `labelIds`.
