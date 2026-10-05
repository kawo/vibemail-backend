# VibeMail Engine — Build Sequence

> Atomic build order for the VibeMail Engine. Each unit is built and **verified** before the next one starts.
> Binding references: [CONTRACT.md](CONTRACT.md) (endpoints §4, data model §5, two-session rule §6).

## How to use this file

- Work through the units strictly in order.
- A unit is done only when its **Verified** check holds.
- If a check fails, fix that unit before starting the next. Do not carry a failure forward.

---

## Units

### 1. Provider abstraction interface
**What:** A TypeScript interface, `MailProvider`, through which all server logic talks to the mail provider. It only declares methods and contains no implementation. It covers the six Gmail operations in CONTRACT.md §4:

| Method | Gmail call it maps to | Used by |
|---|---|---|
| `listInboxMessageIds(max)` | `users.messages.list` (`labelIds: ['INBOX']`) | Full sync (§4.2) |
| `getMessage(id)` | `users.messages.get` (`format: 'full'`) | Sync, send (§4.2, §4.3) |
| `listHistory(startHistoryId, pageToken?)` | `users.history.list` → `history[]` (`messagesAdded`, `messagesDeleted`, `labelsAdded`, `labelsRemoved`), `nextPageToken`, `historyId` | Incremental sync (§4.2) |
| `sendMessage(raw, threadId?)` | `users.messages.send` (`raw` base64url) | Send (§4.3) |
| `markRead(id)` | `users.messages.modify` (`removeLabelIds: ['UNREAD']`) | Mark as read (§4.4) |
| `watch()` | `users.watch` (`topicName`, `labelIds: ['INBOX']`) → `historyId`, `expiration` | Push registration and renewal (§4.5) |

**Verified:** TypeScript compiles clean (`npm run typecheck`), and the interface defines all required methods (the six above).

### 2. Gmail OAuth layer with token persistence listener
**What:** Everything that gets Google tokens and keeps them current:
- **Bearer auth.** `requireUser(request)` in `src/middleware` verifies `Authorization: Bearer <Supabase access token>` with `jsonwebtoken` against `JWT_SECRET` (HS256 only, `aud: 'authenticated'`, issuer checked) and yields `userId` and `email` (CONTRACT.md §3.1). There are no cookies and no anon key.
- **Connect Gmail.** `POST /api/v1/auth/google/callback` (CONTRACT.md §4.1). The frontend has already run Supabase's Google sign-in with `access_type: 'offline'` and `prompt: 'consent'`, and posts the `providerRefreshToken` it received. The backend then:
  1. proves the token with one `refreshAccessToken()`;
  2. checks with token info that the Google account's email equals the bearer's email and that both Gmail scopes were granted;
  3. upserts `users` with the refresh token, access token, expiry and scopes;
  4. calls `watch()`, then runs the initial full sync from unit 3. That sync is wired in once unit 3 exists; until then the step is a no-op.
- **Client factory.** Builds a per-user `googleapis` `OAuth2Client` and seeds it with the stored `refresh_token`, `access_token` and `expiry_date`. The library reuses the access token until it is within 5 minutes of expiry (`eagerRefreshThresholdMillis`, default 300 000 ms), then refreshes.
- **Persistence listener.** Registered on the client with `client.on('tokens', …)`. The library emits this event on every refresh, and the listener:
  - always writes `access_token` and `access_token_expires_at` (from `expiry_date`) together;
  - also writes `refresh_token`, but only when the event carries a new one.

  An access token is never stored without its expiry: the library treats a missing `expiry_date` as never expiring, and a DB `CHECK` enforces the pairing (CONTRACT.md §3.1, §5.2).
- **Revocation.** A refresh that fails with `invalid_grant` is surfaced as `GMAIL_TOKEN_REVOKED`, and the stored access token and its expiry are cleared.

**Verified:** OAuth completes, tokens are stored, and refresh works without mismatch. Concretely:
- A connect request with a valid bearer and a valid refresh token returns `200` and leaves a `users` row with non-null `refresh_token`, `access_token` and `access_token_expires_at`.
- The same request is rejected:
  - with `401 UNAUTHENTICATED` when there is no bearer;
  - with `401 GMAIL_TOKEN_REVOKED` when the refresh token is bad;
  - with `400 VALIDATION_FAILED` (`EMAIL_MISMATCH`) when the Google account's email differs from the bearer's;
  - with `409 GMAIL_NOT_CONNECTED` when a Gmail scope is missing.

  In each rejected case, no row is written.
- With a stored access token more than 5 minutes from expiry, a Gmail call reuses it and makes no token-endpoint request.
- With one within 5 minutes of expiry, the call triggers exactly one refresh, and the DB then holds the new `access_token` and its new expiry.
- After any refresh, the refresh token held by the client is identical to the one in `users`, both when Google omits `refresh_token` from the response and when the `tokens` event delivers a rotated one.
- An `UPDATE` that sets `access_token` with a null `access_token_expires_at` is rejected by the `CHECK` constraint.

### 3. Sync and read layer
**What:** Gets mail from Gmail into the `messages` table and reads it back out as `MessageDTO`s (CONTRACT.md §4.2, §5.1). Its parts:
- **Parser.** A pure function that turns a Gmail `format=full` message into a `messages` row. It matches headers case-insensitively, walks MIME parts recursively, base64url-decodes `text/plain` and `text/html`, collects attachment metadata, converts `internalDate` from epoch-ms, and derives `is_read` from the `UNREAD` label.
- **Initial (full) sync.** `listInboxMessageIds(50)` is called once with no paging; Gmail returns IDs newest first. Then `getMessage` is called for each ID, each row is upserted on `(user_id, gmail_id)`, and `last_history_id` is set from the newest message.
- **Incremental sync.** `listHistory` from `last_history_id`, with a fallback to full sync when Gmail returns 404.
- **Read side.** A repository query that returns INBOX rows ordered `(internal_date DESC, gmail_id DESC)` with keyset cursor pagination, mapped to `MessageDTO`. It never calls Gmail.
- **Triggers.** Sync is push-driven only (CONTRACT.md §3.5): the full sync runs at connect (unit 2) and on the webhook's fallback, and the incremental sync runs from the webhook (unit 4). Nothing polls Gmail.

**Verified:** Initial sync fetches 50 messages, the objects match the contract model, and incremental sync applies only the changes since the last sync. Concretely:
- Against an inbox holding more than 50 messages, a first sync stores exactly the 50 newest.
- Every stored row, and the `MessageDTO` read back from it, matches CONTRACT.md §5.1 / §3.4 field for field, with correct types and nulls. This is checked against a recorded fixture that includes nested multipart and an attachment.
- **Incremental sync.** A second sync calls `history.list` with `startHistoryId` equal to the stored `last_history_id`. It then applies exactly the recorded changes and nothing else:
  - one added message is fetched and inserted;
  - one deleted message's row is removed;
  - a removed `UNREAD` label flips `is_read` to `true`.

  It makes no `messages.list` call, and `last_history_id` advances to the response's `historyId`.
- **404 fallback.** When `history.list` returns 404, the sync falls back to a full sync (the 50 newest), and `last_history_id` is reset from the newest message.
- **No polling.** Listing messages through the read side, with a fake `MailProvider` that throws on any call, succeeds and makes zero Gmail calls.

### 4. Pub/Sub webhook receiver
**What:** `POST /webhook/gmail` (CONTRACT.md §4.5; function file `api/webhook/gmail.ts`, reached through a `vercel.json` rewrite) together with watch registration and renewal:
- **Authentication.** Compares the `?token=` query parameter to `GOOGLE_PUBSUB_VERIFICATION_TOKEN` in constant time, and fails closed if the variable is unset.
- **Decoding.** Base64url-decodes `message.data` into `{ emailAddress, historyId }` and looks up the account by email.
- **Delta.** If the notification's `historyId` is not newer than the stored `last_history_id`, it acks and makes no Gmail calls. Otherwise it runs unit 3's incremental sync from the **stored** `last_history_id`. The notification's ID is the mailbox's new state, not the start point.
- **Concurrency.** `last_history_id` only ever advances, under a per-user advisory lock, so webhook and list syncs can't clobber each other. Both are implemented in the DB by `apply_sync_batch` / `advance_last_history_id` (CONTRACT.md §5.5), called with `.rpc()`.
- **Acks.** `204` acks. Only retryable failures return non-2xx, which makes Pub/Sub redeliver.
- **Watch.** `watch()` is called after the OAuth callback. Daily renewal is a separate cron job (`GET /api/cron/renew-watches`, CONTRACT.md §4.6), with its logic in `src/cron`; user requests never call `watch()`.
- **Cron renewal.** The cron logic checks the `CRON_SECRET` bearer and fails closed if the secret is unset. It renews every connected account with a concurrency limit of 5, isolates failures per account, and clears tokens on `invalid_grant`.

**Verified:** A notification fetches the correct delta through history ID. Concretely:
- Given a stored `last_history_id = H` and a notification carrying `historyId = H2 > H`, the receiver calls `history.list` with `startHistoryId = H`, never `H2`.
- It applies exactly the adds, deletes and label changes recorded after `H`, and leaves `last_history_id` advanced (not regressed).
- A replayed notification with `historyId ≤ H` makes zero Gmail calls and returns `204`.
- The renewal job, given three accounts where one throws `invalid_grant`, renews the other two, clears the third's tokens, and reports `{ renewed: 2, revoked: 1, failed: 0 }`.

### 5. Send layer
**What:** `POST /api/v1/messages/send` (CONTRACT.md §4.3):
- **Validation.** Recipients must be valid addresses, at most 100 in total. CR/LF in any header is rejected to block header injection. At least one of `text`/`html` is required.
- **MIME builder.** Produces an RFC 2822 message: `From` is the account email from `public.users.email`, the subject is RFC 2047-encoded, and the body is `multipart/alternative` when both text and HTML are given, a single part otherwise.
- **Send.** The message is base64url-encoded into `raw` and sent with `MailProvider.sendMessage(raw, threadId?)`.
- **Replies.** Gmail threads a reply only when the request carries the original `threadId`, the `In-Reply-To`/`References` headers follow RFC 2822, and the `Subject` matches. So for a reply the builder sets `In-Reply-To` and `References` from the stored original, derives the subject server-side (CONTRACT.md §4.3: `Re: <original subject>` unless it already starts with `Re:`, ignoring any client `subject`), and passes the original's `thread_id`.
- **Store.** The sent message is fetched back with `getMessage` and upserted through unit 3's parser, then returned as `201 { message }`.

**Verified:** A message sends successfully through Gmail for an authenticated user. Concretely:
- An authenticated `POST` returns `201` with a `MessageDTO` whose `gmailId` exists in Gmail and whose `labelIds` include `SENT`, and the same row is in `messages`.
- The `raw` sent to Gmail decodes to valid MIME with the expected `From`/`To`/`Subject` and bodies.
- An unauthenticated request returns `401 UNAUTHENTICATED` and makes no Gmail call.

### 6. Mark-as-read layer
**What:** The logic behind `POST /api/v1/messages/{id}/read` (CONTRACT.md §4.4):
1. Look up the row `(user_id, gmail_id = id)`. If there isn't one → `MESSAGE_NOT_FOUND`, with no Gmail call.
2. Call `MailProvider.markRead(id)`, which runs `users.messages.modify` with `removeLabelIds: ['UNREAD']` and returns the message's updated `labelIds`.
3. Write those `labelIds` to the row, set `is_read = true` and `synced_at = now()`, and return the row as a `MessageDTO`.
4. A Gmail 404 deletes the stale row and returns `MESSAGE_NOT_FOUND`.
5. Rate-limit, revoked-token and upstream failures map to their §3.3 codes.

**Verified:** Marking an unread message as read sends exactly one Gmail `modify` call with `removeLabelIds: ['UNREAD']`. The stored row then has `is_read = true` and no `UNREAD` in `label_ids`. Repeating the call returns the same `MessageDTO` with `isRead: true` and no error. An ID that isn't in the user's rows (including another user's message) returns `MESSAGE_NOT_FOUND` without calling Gmail.

### 7. Vercel API function entry points
**What:** The standalone Vercel Functions under the top-level `api/` directory. There is no framework: Vercel's zero-config detection builds every `api/**/*.ts` file with `@vercel/node`, and the file path is the URL. Each file is a thin wrapper: it parses the request, calls the layer built in units 2–6, and maps errors to the CONTRACT.md §3.3 envelope. Business logic stays in `src/`.

| Function file | Endpoint | Layer |
|---|---|---|
| `api/v1/auth/google/callback.ts` | `POST /api/v1/auth/google/callback` §4.1 | Unit 2 (`src/providers/gmail`) |
| `api/v1/messages/index.ts` | `GET /api/v1/messages` §4.2 | Unit 3 read side (`src/db`) |
| `api/v1/messages/send.ts` | `POST /api/v1/messages/send` §4.3 | Unit 5 (`src/send`) |
| `api/v1/messages/[id]/read.ts` | `POST /api/v1/messages/{id}/read` §4.4 | Unit 6 |
| `api/webhook/gmail.ts` | `POST /webhook/gmail` §4.5 (rewrite → `/api/webhook/gmail`) | Unit 4 (`src/webhook`) |
| `api/cron/renew-watches.ts` | `GET /api/cron/renew-watches` §4.6 | Unit 4 (`src/cron`) |

Vercel details for these files:
- **Handler shape.** Each file exports named Web-standard handlers, `export async function GET(request: Request): Promise<Response>` or `POST`, and nothing else. An HTTP method with no exported handler gets `405`.
- **Runtime.** Node.js only, because `googleapis` and `google-auth-library` need Node APIs. No Edge runtime. Responses send `Cache-Control: no-store`.
- **Auth.** No cookies. A shared `requireUser(request)` in `src/middleware`:
  - reads `Authorization: Bearer <token>` and verifies it with `jwt.verify` (HS256, `JWT_SECRET`, audience and issuer checked);
  - returns `{ userId, email }`. All DB access goes through the `src/db` repository on the single service-role client, scoped by `userId` (CONTRACT.md §5.3);
  - fails with `UNAUTHENTICATED` when the token is missing or invalid.

  The four user-facing functions call it first.
- **Path param.** `[id]/read.ts` reads `id` from `new URL(request.url).pathname`, decodes it, and rejects an empty value with `VALIDATION_FAILED`.
- **Routing.** `vercel.json` holds the rewrite `/webhook/gmail` → `/api/webhook/gmail`.
- **Duration.** `vercel.json` sets `functions["api/v1/auth/google/callback.ts"].maxDuration` and `functions["api/webhook/gmail.ts"].maxDuration`, because both run a sync. It also sets `functions["api/cron/renew-watches.ts"].maxDuration = 300`, and the `crons` entry from CONTRACT.md §4.6. A function that exceeds it gets a platform `504`.
- **Env.** Local env comes from `vercel env pull`.

**Verified:** All six endpoints respond correctly in local preview (`vercel dev` with the local Supabase stack):
- `vercel dev` lists all six functions at the exact paths in the table, and nothing is served under `/api/` except those.
- Each endpoint returns its CONTRACT.md §4 success status and body shape for a valid request.
- Each returns `405` for an unsupported method.
- Every user-facing function returns `401 UNAUTHENTICATED` without a bearer and with a tampered or expired one. A valid local-Supabase user token is accepted, and no response sets a cookie.
- Each returns the correct §3.3 envelope for an unauthenticated or invalid one.
- The webhook is exercised by replaying a recorded Pub/Sub push body to `/webhook/gmail?token=$GOOGLE_PUBSUB_VERIFICATION_TOKEN`, and returns `401` with a wrong or missing token.
- An `OPTIONS` preflight to any `/api/v1` endpoint from `FRONTEND_URL` returns `204` with the CORS headers in CONTRACT.md §3.2.
- The cron function is called by hand with `Authorization: Bearer $CRON_SECRET` and returns `200` with the §4.6 counts. Without the header it returns `401`.
- A real Google-signed delivery is out of scope for this unit; it is checked on a Vercel preview deployment.

### 8. Integration tests
**What:** The Jest integration suite (`ts-jest`, `tests/integration/`) that proves CONTRACT.md §2 end to end. It runs against a **running local Supabase stack** (real Postgres, Auth and PostgREST), not a mocked database client.
- **Database.** The suite runs in the Gate 1 worktree (`main` merged with `schema`, CONTRACT.md §6). The stack is started with `supabase start` and reset with `supabase db reset` before the run, which applies the schema branch's migration from `supabase/migrations/`. Local URL and keys come from `supabase status`.
- **Gmail.** Gmail is replaced by a fake `MailProvider` (unit 1) loaded with recorded `format=full`, `history.list`, `send` and `watch` fixtures. No Google account or network is needed.
- **Coverage.** The suite includes:
  - every endpoint's success path and every `ErrorCode` in its error table (§2, criterion 2);
  - the sync, fallback and 50-message cap cases;
  - webhook delta and duplicate handling;
  - cron auth (`401` without the bearer, fail closed without `CRON_SECRET`) and per-account failure isolation;
  - mark-read idempotence;
  - reply threading;
  - `invalid_grant` → `GMAIL_TOKEN_REVOKED`;
  - an isolation test using two real local Auth users, proving that user A cannot read or modify user B's rows through any endpoint;
  - a check that RLS is enabled with no policies, so a direct Data API call with a user token returns no rows;
  - rejection of a token signed with the wrong secret, of one with `alg: none`, and of one with the wrong audience.
- **Hosted projects.** No hosted Supabase project is touched, in line with CONTRACT.md §6. If the Supabase GitHub integration is enabled, `schema` must not be merged into `main` before Gate 1, because merging runs the migration against production.

**Verified:** The full suite passes with no skipped tests against live Supabase, where "live" means the running local stack. Concretely:
- After `supabase db reset`, `jest --ci --runInBand --json --outputFile=jest-results.json` exits 0. `--runInBand` is used because all tests share one local database.
- In the JSON report, `numFailedTests`, `numPendingTests` and `numTodoTests` are all `0`, and `numPassedTests === numTotalTests`.
- Jest has no option to fail on `.only`. Instead, a leftover `.only` shows up because Jest reports every test it skipped as pending, so `numPendingTests` is no longer `0`. The lint gate also bans it with `eslint-plugin-jest`'s `jest/no-focused-tests`, set to `error`.

---

## Relation to the two-session rule (CONTRACT.md §6)

- **Schema session first (draft).** On the `schema` branch: `supabase/migrations/` and `src/types/`, pushed but not merged or reviewed. Units 2–8 need both.
- **Units 1–8 belong to the server session** on `main`. Every unit's check runs in the Gate 1 worktree (`main` merged with `schema`), because `main` alone lacks `src/types/`.
- **Gate 1:** unit 8 passing, so `npm test` exits 0, plus `npm run typecheck` and lint clean.
- **Schema session (review + merge)** happens only after Gate 1, and it adds no build units.
