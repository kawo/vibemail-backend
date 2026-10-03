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

**Verified:** TypeScript compiles clean (`tsc --noEmit`), and the interface defines all required methods (the six above).

### 2. Gmail OAuth layer with token persistence listener
**What:** Everything that gets Google tokens and keeps them current:
- **OAuth callback.** `GET /api/auth/callback` (CONTRACT.md §4.1) exchanges the code with `exchangeCodeForSession`. It then upserts into `gmail_accounts`:
  - `session.provider_refresh_token`;
  - `session.provider_token` as `access_token`;
  - `access_token_expires_at`, set to `now() + expires_in` from token info.

  Sign-in uses `access_type: 'offline'` and `prompt: 'consent'`.
- **Client factory.** Builds a per-user `googleapis` `OAuth2Client` and seeds it with the stored `refresh_token`, `access_token` and `expiry_date`. The library reuses the access token until it is within 5 minutes of expiry (`eagerRefreshThresholdMillis`, default 300 000 ms), then refreshes.
- **Persistence listener.** Registered on the client with `client.on('tokens', …)`. The library emits this event on every refresh, and the listener:
  - always writes `access_token` and `access_token_expires_at` (from `expiry_date`) together;
  - also writes `refresh_token`, but only when the event carries a new one.

  An access token is never stored without its expiry: the library treats a missing `expiry_date` as never expiring, and a DB `CHECK` enforces the pairing (CONTRACT.md §3.1, §5.2).
- **Revocation.** A refresh that fails with `invalid_grant` is surfaced as `GMAIL_TOKEN_REVOKED`, and the stored access token and its expiry are cleared.

**Verified:** OAuth completes, tokens are stored, and refresh works without mismatch. Concretely:
- The callback 302s to `next` and leaves a `gmail_accounts` row with non-null `refresh_token`, `access_token` and `access_token_expires_at`.
- With a stored access token more than 5 minutes from expiry, a Gmail call reuses it and makes no token-endpoint request.
- With one within 5 minutes of expiry, the call triggers exactly one refresh, and the DB then holds the new `access_token` and its new expiry.
- After any refresh, the refresh token held by the client is identical to the one in `gmail_accounts`, both when Google omits `refresh_token` from the response and when the `tokens` event delivers a rotated one.
- An `UPDATE` that sets `access_token` with a null `access_token_expires_at` is rejected by the `CHECK` constraint.

### 3. Sync and read layer
**What:** Gets mail from Gmail into the `messages` table and reads it back out as `MessageDTO`s (CONTRACT.md §4.2, §5.1). Its parts:
- **Parser.** A pure function that turns a Gmail `format=full` message into a `messages` row. It matches headers case-insensitively, walks MIME parts recursively, base64url-decodes `text/plain` and `text/html`, collects attachment metadata, converts `internalDate` from epoch-ms, and derives `is_read` from the `UNREAD` label.
- **Initial (full) sync.** `listInboxMessageIds(50)` is called once with no paging; Gmail returns IDs newest first. Then `getMessage` is called for each ID, each row is upserted on `(user_id, gmail_id)`, and `last_history_id` is set from the newest message.
- **Incremental sync.** `listHistory` from `last_history_id`, with a fallback to full sync when Gmail returns 404.
- **Read side.** A repository query that returns INBOX rows ordered `(internal_date DESC, gmail_id DESC)` with keyset cursor pagination, mapped to `MessageDTO`.

**Verified:** Initial sync fetches 50 messages, the objects match the contract model, and incremental sync applies only the changes since the last sync. Concretely:
- Against an inbox holding more than 50 messages, a first sync stores exactly the 50 newest.
- Every stored row, and the `MessageDTO` read back from it, matches CONTRACT.md §5.1 / §3.4 field for field, with correct types and nulls. This is checked against a recorded fixture that includes nested multipart and an attachment.
- **Incremental sync.** A second sync calls `history.list` with `startHistoryId` equal to the stored `last_history_id`. It then applies exactly the recorded changes and nothing else:
  - one added message is fetched and inserted;
  - one deleted message's row is removed;
  - a removed `UNREAD` label flips `is_read` to `true`.

  It makes no `messages.list` call, and `last_history_id` advances to the response's `historyId`.
- **404 fallback.** When `history.list` returns 404, the sync falls back to a full sync (the 50 newest), and `last_history_id` is reset from the newest message.

### 4. Pub/Sub webhook receiver
**What:** `POST /api/webhooks/gmail` (CONTRACT.md §4.5) together with watch registration and renewal:
- **Authentication.** Verifies the Pub/Sub OIDC bearer token (`aud`, service-account `email`, `email_verified`).
- **Decoding.** Base64url-decodes `message.data` into `{ emailAddress, historyId }` and looks up the account by email.
- **Delta.** If the notification's `historyId` is not newer than the stored `last_history_id`, it acks and makes no Gmail calls. Otherwise it runs unit 3's incremental sync from the **stored** `last_history_id`. The notification's ID is the mailbox's new state, not the start point.
- **Concurrency.** `last_history_id` only ever advances, under a per-user advisory lock, so webhook and list syncs can't clobber each other.
- **Acks.** `204` acks. Only retryable failures return non-2xx, which makes Pub/Sub redeliver.
- **Watch.** `watch()` is called after the OAuth callback and renewed on any user request when `watch_expiration` is less than 24 h away.

**Verified:** A notification fetches the correct delta through history ID. Concretely:
- Given a stored `last_history_id = H` and a notification carrying `historyId = H2 > H`, the receiver calls `history.list` with `startHistoryId = H`, never `H2`.
- It applies exactly the adds, deletes and label changes recorded after `H`, and leaves `last_history_id` advanced (not regressed).
- A replayed notification with `historyId ≤ H` makes zero Gmail calls and returns `204`.

### 5. Send layer
**What:** `POST /api/messages/send` (CONTRACT.md §4.3):
- **Validation.** Recipients must be valid addresses, at most 100 in total. CR/LF in any header is rejected to block header injection. At least one of `text`/`html` is required.
- **MIME builder.** Produces an RFC 2822 message: `From` is the account email from `gmail_accounts.email`, the subject is RFC 2047-encoded, and the body is `multipart/alternative` when both text and HTML are given, a single part otherwise.
- **Send.** The message is base64url-encoded into `raw` and sent with `MailProvider.sendMessage(raw, threadId?)`.
- **Replies.** Gmail threads a reply only when the request carries the original `threadId`, the `In-Reply-To`/`References` headers follow RFC 2822, and the `Subject` matches. So for a reply the builder sets `In-Reply-To` and `References` from the stored original, derives the subject server-side (CONTRACT.md §4.3: `Re: <original subject>` unless it already starts with `Re:`, ignoring any client `subject`), and passes the original's `thread_id`.
- **Store.** The sent message is fetched back with `getMessage` and upserted through unit 3's parser, then returned as `201 { message }`.

**Verified:** A message sends successfully through Gmail for an authenticated user. Concretely:
- An authenticated `POST` returns `201` with a `MessageDTO` whose `gmailId` exists in Gmail and whose `labelIds` include `SENT`, and the same row is in `messages`.
- The `raw` sent to Gmail decodes to valid MIME with the expected `From`/`To`/`Subject` and bodies.
- An unauthenticated request returns `401 UNAUTHENTICATED` and makes no Gmail call.

### 6. Mark-as-read layer
**What:** The logic behind `POST /api/messages/{id}/read` (CONTRACT.md §4.4):
1. Look up the row `(user_id, gmail_id = id)`. If there isn't one → `MESSAGE_NOT_FOUND`, with no Gmail call.
2. Call `MailProvider.markRead(id)`, which runs `users.messages.modify` with `removeLabelIds: ['UNREAD']` and returns the message's updated `labelIds`.
3. Write those `labelIds` to the row, set `is_read = true` and `synced_at = now()`, and return the row as a `MessageDTO`.
4. A Gmail 404 deletes the stale row and returns `MESSAGE_NOT_FOUND`.
5. Rate-limit, revoked-token and upstream failures map to their §3.3 codes.

**Verified:** Marking an unread message as read sends exactly one Gmail `modify` call with `removeLabelIds: ['UNREAD']`. The stored row then has `is_read = true` and no `UNREAD` in `label_ids`. Repeating the call returns the same `MessageDTO` with `isRead: true` and no error. An ID that isn't in the user's rows (including another user's message) returns `MESSAGE_NOT_FOUND` without calling Gmail.

### 7. Vercel API function entry points
**What:** The Next.js App Router route files that Vercel deploys as functions. Each one is a thin wrapper: it parses the request, calls the layer built in units 2–6, and maps errors to the CONTRACT.md §3.3 envelope.

| Route file | Endpoint | Layer |
|---|---|---|
| `app/api/auth/callback/route.ts` | `GET` §4.1 | Unit 2 |
| `app/api/messages/route.ts` | `GET` §4.2 | Unit 3 |
| `app/api/messages/send/route.ts` | `POST` §4.3 | Unit 5 |
| `app/api/messages/[id]/read/route.ts` | `POST` §4.4 | Unit 6 |
| `app/api/webhooks/gmail/route.ts` | `POST` §4.5 | Unit 4 |

Next.js and Vercel details for these files:
- **Runtime.** Every file exports `runtime = 'nodejs'`, because `googleapis` needs Node, and `dynamic = 'force-dynamic'`, so responses are never cached.
- **Duration.** The sync routes (§4.2, §4.5) also set `maxDuration`.
- **Params.** In `[id]/read`, `params` is a Promise in Next.js 15+ and is `await`ed.
- **Env.** Local env comes from `vercel env pull`.

**Verified:** All five endpoints respond correctly in local preview (`vercel dev` with the local Supabase stack):
- Each endpoint returns its CONTRACT.md §4 success status and body shape for a valid request.
- Each returns the correct §3.3 envelope for an unauthenticated or invalid one.
- The webhook is exercised by replaying a recorded Pub/Sub push body with `PUBSUB_VERIFY_DISABLED=true` (CONTRACT.md §4.5).
- A real Google-signed delivery is out of scope for this unit; it is checked on a Vercel preview deployment.

### 8. Integration tests
**What:** The Vitest integration suite that proves CONTRACT.md §2 end to end. It runs against a **running local Supabase stack** (real Postgres, Auth and PostgREST), not a mocked database client.
- **Database.** The stack is started with `supabase start` and reset with `supabase db reset` before the run, which applies the draft migration from `supabase/migrations/`. Local URL and keys come from `supabase status`.
- **Gmail.** Gmail is replaced by a fake `MailProvider` (unit 1) loaded with recorded `format=full`, `history.list`, `send` and `watch` fixtures. No Google account or network is needed.
- **Coverage.** The suite includes:
  - every endpoint's success path and every `ErrorCode` in its error table (§2, criterion 2);
  - the sync, fallback and 50-message cap cases;
  - webhook delta and duplicate handling;
  - mark-read idempotence;
  - reply threading;
  - `invalid_grant` → `GMAIL_TOKEN_REVOKED`;
  - an RLS test using two real Auth users, proving user A cannot read or modify user B's rows.
- **Hosted projects.** No hosted Supabase project is touched, in line with CONTRACT.md §6. If the Supabase GitHub integration is enabled, the draft migration must stay off the default branch, because merging it there runs it against production.

**Verified:** The full suite passes with no skipped tests against live Supabase, where "live" means the running local stack. Concretely:
- After `supabase db reset`, `vitest run --reporter=json --allowOnly=false` exits 0.
- In the JSON report, `numFailedTests`, `numPendingTests` and `numTodoTests` are all `0`, and `numPassedTests === numTotalTests`.
- `--allowOnly=false` makes any leftover `.only` fail the run instead of silently skipping the other tests.

---

## Relation to the two-session rule (CONTRACT.md §6)

- **Units 1–8 are all Session 1.** The draft migration is written alongside unit 2, because that is the first unit to touch the database, and it stays local and unmerged throughout.
- **Gate 1:** unit 8 passing, plus `tsc --noEmit` and lint clean.
- **Session 2** starts only after Gate 1. It reviews and merges the schema; there are no further build units.
