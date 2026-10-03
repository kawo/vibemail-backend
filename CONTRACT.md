# VibeMail Engine — Contract

> Status: **v1, binding.** Any change to an endpoint, error code, or stored field is made in this file first (see §7).
> Stack: Next.js App Router route handlers · TypeScript · Supabase (Postgres + Auth) · `googleapis` (Gmail API v1).

---

## 1. Purpose & scope

The VibeMail Engine is the backend that connects a user's Gmail account, mirrors their mail into Supabase, and exposes four user-facing endpoints (OAuth callback, message list, message send, mark as read) plus one machine-facing endpoint (the Gmail Pub/Sub webhook).

**In scope (v1)**

- Google sign-in through Supabase Auth with offline access to Gmail.
- Incremental Gmail → DB sync, triggered two ways:
  - by Gmail push notifications (Pub/Sub webhook, §4.5);
  - by the message-list request, as a backstop.
- Gmail `users.watch` registration and renewal (§4.5).
- Listing INBOX messages from the DB with cursor pagination.
- Sending new messages and replies (plain text and/or HTML).
- Marking a single message as read.

**Out of scope (v1)**

- Attachments on send (stored attachment *metadata* on received mail is in scope).
- Label/unread filters, search, and thread-grouped views.
- Cron or scheduled jobs (watch renewal piggybacks on user requests instead; see §4.5).
- Mark as unread, archive, delete, and batch operations.
- Multiple Gmail accounts per user.

---

## 2. Acceptance criteria

The project is complete when **every** item below is true and verifiable.

1. All five routes exist at the exact paths in §4 and accept/return exactly the shapes defined there.
2. Every `ErrorCode` listed in an endpoint's error table has at least one Vitest test that triggers it and asserts the HTTP status (or redirect target, for the callback) and the error envelope from §3.3.
3. `vitest run` passes, including integration tests running against local Supabase (`supabase start`) with the draft migration applied.
4. `tsc --noEmit` passes with `strict: true`, and lint passes with zero errors.
5. A fixture test maps a recorded Gmail `users.messages.get?format=full` response to a `messages` row that matches §5 field for field. It includes a nested `multipart/alternative` inside `multipart/mixed` and one attachment.
6. Sync is tested for: first sync (no stored `historyId` → full sync, which stores at most 50 messages even when the inbox holds more), incremental sync (`history.list`), and fallback (`history.list` returns HTTP 404 → full sync).
7. Mark-as-read is idempotent: calling it twice on the same message returns `200` both times with `isRead: true`.
8. Replying with `replyToMessageId` sets the `In-Reply-To` and `References` headers, derives the `Re:` subject per §4.3 (ignoring any client `subject`), and sends with the original `threadId` (asserted on the raw MIME and the Gmail request).
9. A Google `invalid_grant` on token refresh maps to `GMAIL_TOKEN_REVOKED` on every Gmail-backed endpoint, and clears the stored access token.
   Access-token persistence (§3.1) is tested:
   - a stored token more than 5 minutes from expiry is reused with no refresh call;
   - a token within 5 minutes of expiry is refreshed, and the new token and expiry are persisted;
   - writing an access token without an expiry is rejected by the DB.
10. The webhook is tested for these cases:
    - **Valid notification:** applies exactly the history delta since the stored `last_history_id`.
    - **Duplicate or stale notification:** a notification whose `historyId` is ≤ the stored one makes no Gmail calls.
    - **Bad or missing OIDC token:** rejected with `401`.
    - **Unknown mailbox:** acknowledged without any Gmail call.
    - **Watch renewal:** `users.watch` is called when `watch_expiration` is null or less than 24 h away.
11. Row Level Security is tested: user A cannot read or modify user B's `messages` or `gmail_accounts` rows.
12. The sequencing rule in §6 was followed, and its gates are recorded in the PR descriptions.

---

## 3. Shared conventions

### 3.1 Authentication

- Every endpoint except the OAuth callback and the webhook (§4.5, which authenticates with a Pub/Sub OIDC token) requires a Supabase session cookie, read server-side with `@supabase/ssr` (`createServerClient` + `supabase.auth.getUser()`).
- Gmail calls use a `googleapis` `OAuth2` client built from the app's Google client ID/secret (env). Its credentials are seeded from `gmail_accounts`: `refresh_token`, `access_token`, and `expiry_date` (from `access_token_expires_at`, as epoch ms).
- **Access-token persistence.**
  - **Reuse.** The client reuses the stored access token until it is within 5 minutes of expiry, the library's default `eagerRefreshThresholdMillis`. Then it refreshes.
  - **Listener.** A `client.on('tokens')` listener persists every refresh:
    - `access_token` and `access_token_expires_at` are always written;
    - `refresh_token` is written only when Google returns a new one.
  - **Paired columns.** `access_token` and `access_token_expires_at` are always written together, or both set to `null`. `google-auth-library` treats a credential with no `expiry_date` as *never expiring*, so an access token stored without an expiry would never be refreshed. A DB `CHECK` enforces the pairing (§5.2).
  - **Revocation.** On `invalid_grant`, both access-token columns are set to `null`.
- Required Google scopes: `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/gmail.send`. Sign-in is started with `queryParams: { access_type: 'offline', prompt: 'consent' }` so that Google returns a refresh token.

### 3.2 Format

- JSON request and response bodies use camelCase. DB columns use snake_case.
- Timestamps in JSON are ISO-8601 UTC strings (`2026-10-03T14:05:00.000Z`).
- Gmail IDs (`id`, `threadId`, `historyId`) are always strings.

### 3.3 Error envelope

Every JSON error response has this shape. The callback reports errors by redirect instead (§4.1).

```ts
type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'GMAIL_NOT_CONNECTED'
  | 'GMAIL_TOKEN_REVOKED'
  | 'VALIDATION_FAILED'
  | 'MESSAGE_NOT_FOUND'
  | 'GMAIL_RATE_LIMITED'
  | 'GMAIL_UPSTREAM_ERROR'
  | 'SYNC_FAILED'
  | 'INTERNAL';

interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;          // human-readable, safe to show; never contains tokens
    retryable: boolean;
    details?: Record<string, unknown>; // e.g. { issues: ZodIssue[] } for VALIDATION_FAILED
  };
}
```

| Code | HTTP | `retryable` | Meaning |
|---|---|---|---|
| `UNAUTHENTICATED` | 401 | false | No valid Supabase session, or the OAuth code exchange failed. |
| `GMAIL_NOT_CONNECTED` | 409 | false | The user has no `gmail_accounts` row, no refresh token, or is missing the required scopes. |
| `GMAIL_TOKEN_REVOKED` | 401 | false | Google rejected the refresh token (`invalid_grant`). The user must sign in again. |
| `VALIDATION_FAILED` | 400 | false | The request params or body failed validation. |
| `MESSAGE_NOT_FOUND` | 404 | false | The message ID is not in this user's mailbox (DB or Gmail). |
| `GMAIL_RATE_LIMITED` | 429 | true | Gmail returned 429 or a 403 `rateLimitExceeded`/`userRateLimitExceeded`. Sets the `Retry-After` header (seconds). |
| `GMAIL_UPSTREAM_ERROR` | 502 | true | Gmail returned 5xx or an unexpected 4xx. |
| `SYNC_FAILED` | 502 | true | The sync step of the list endpoint failed for a reason other than auth or rate limit. |
| `INTERNAL` | 500 | false | Unhandled server or DB error. |

### 3.4 `MessageDTO`

Every endpoint that returns a message uses this shape. It is the §5 `messages` row in camelCase, without `id`, `user_id`, `created_at`, `updated_at`.

```ts
interface AttachmentMeta {
  partId: string;
  filename: string;
  mimeType: string;
  size: number;          // bytes
  attachmentId: string;
}

interface MessageDTO {
  gmailId: string;
  threadId: string;
  labelIds: string[];
  isRead: boolean;
  snippet: string;
  historyId: string;
  internalDate: string;          // ISO-8601
  sizeEstimate: number;
  subject: string | null;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  rfc822MessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  dateHeader: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: AttachmentMeta[];
  syncedAt: string;              // ISO-8601
}
```

---

## 4. Endpoint contracts

### 4.1 OAuth callback — `GET /api/auth/callback`

This is the redirect target for Supabase Auth's Google PKCE flow. It always answers with **302**, never JSON.

**Request**

```ts
// Query string
interface CallbackQuery {
  code?: string;   // PKCE auth code from Supabase
  next?: string;   // post-login path; must start with "/" and not "//"; default "/"
}
```

**Behavior**

1. If `code` is missing → error `VALIDATION_FAILED`.
2. Call `supabase.auth.exchangeCodeForSession(code)`. On error → `UNAUTHENTICATED`.
3. Read `session.provider_refresh_token` and `session.provider_token`. If there is no refresh token → `GMAIL_NOT_CONNECTED`.
4. Call token info for `provider_token`. If either required scope from §3.1 is missing → `GMAIL_NOT_CONNECTED`.
5. Upsert `gmail_accounts` with:
   - `user_id`;
   - `email` (from `session.user.email`);
   - `refresh_token`;
   - `scopes`;
   - `access_token = provider_token`;
   - `access_token_expires_at = now() + expires_in` (the `expires_in` from the token-info response).

   If token info returns no `expires_in`, both access-token columns are `null`. On re-connect, reset `last_history_id` to `null` (this forces a full sync).
6. Call `MailProvider.watch()` (§4.5). If it fails, log the failure; it does not fail the callback.
7. Redirect.

**Response**

| Outcome | Status | `Location` |
|---|---|---|
| Success | 302 | `{origin}{next}` (or `next` validated to a same-origin relative path; otherwise `/`) |
| Error | 302 | `{origin}/auth/error?code=<ErrorCode>` |

The session cookie is set by the Supabase SSR client on the redirect response.

**Errors** (delivered as the `code` query param)

| Code | Trigger |
|---|---|
| `VALIDATION_FAILED` | `code` param missing or empty. |
| `UNAUTHENTICATED` | `exchangeCodeForSession` returned an error (expired or reused code, PKCE verifier missing). |
| `GMAIL_NOT_CONNECTED` | No `provider_refresh_token`, or the required Gmail scopes were not granted. |
| `INTERNAL` | DB upsert failed or an unexpected exception was thrown. |

---

### 4.2 Message list — `GET /api/messages`

Syncs the user's mailbox from Gmail, then returns INBOX messages from the DB, newest first.

**Request**

```ts
// Query string
interface ListMessagesQuery {
  limit?: number;   // integer 1..100, default 25
  cursor?: string;  // opaque; value of a previous response's nextCursor
}
```

**Behavior**

1. Authenticate (§3.1), then load `gmail_accounts` for the user.
2. **Sync:**
   - If `last_history_id` is `null`, run a **full sync**: `users.messages.list({ labelIds: ['INBOX'], maxResults: 50 })`, a single page with no further paging, so at most the 50 most recent INBOX messages. Then `users.messages.get({ format: 'full' })` each one, upsert it, and set `last_history_id` to the max `historyId` seen.
   - Otherwise run an **incremental sync**: `users.history.list({ startHistoryId: last_history_id, historyTypes: ['messageAdded','messageDeleted','labelAdded','labelRemoved'] })`, paging until done.
     - `messagesAdded` → `get` + upsert.
     - `messagesDeleted` → delete the row.
     - `labelsAdded` / `labelsRemoved` → update `label_ids` and `is_read`.
     - Afterwards, set `last_history_id` to the response's `historyId`.
   - If `history.list` returns **404** (the start ID is outside the retained history window), fall back to a full sync.
   - Set `gmail_accounts.last_synced_at = now()`.
   - Concurrency: the advisory lock and the advance-only `last_history_id` rule from §4.5, step 5, apply to this sync too.
3. **Query:** select rows `WHERE user_id = auth.uid() AND 'INBOX' = ANY(label_ids)`, ordered by `(internal_date DESC, gmail_id DESC)`, using keyset pagination from the cursor and `limit + 1` rows to compute `nextCursor`.

**Cursor:** `base64url(JSON.stringify({ d: internalDateISO, g: gmailId }))`. Clients treat it as opaque.

**Response — `200 OK`**

```ts
interface ListMessagesResponse {
  messages: MessageDTO[];      // length <= limit
  nextCursor: string | null;   // null when there are no more rows
  syncedAt: string;            // ISO-8601, completion time of this request's sync
}
```

**Errors**

| Code | HTTP | Trigger |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No valid session. |
| `GMAIL_NOT_CONNECTED` | 409 | No `gmail_accounts` row or no refresh token. |
| `GMAIL_TOKEN_REVOKED` | 401 | `invalid_grant` during sync. |
| `VALIDATION_FAILED` | 400 | `limit` not an integer in 1..100, or `cursor` fails to decode or has the wrong shape. |
| `GMAIL_RATE_LIMITED` | 429 | Gmail rate limit during sync. |
| `SYNC_FAILED` | 502 | Any other Gmail failure during sync (including 5xx). |
| `INTERNAL` | 500 | DB error or an unexpected exception. |

---

### 4.3 Message send — `POST /api/messages/send`

Sends a new message or a reply through Gmail, then stores the sent message.

**Request** — `Content-Type: application/json`

```ts
interface SendMessageRequest {
  to: string[];               // >= 1 address
  cc?: string[];
  bcc?: string[];
  subject?: string;           // required for new messages (may be ""); max 998 chars, no CR/LF.
                              // ignored when replyToMessageId is set; the server derives it (Behavior §2)
  text?: string;              // at least one of text / html is required
  html?: string;
  replyToMessageId?: string;  // gmailId of a message already stored for this user
}
```

Validation rules:

- Every address is a valid RFC 5322 addr-spec, or `Name <addr-spec>`.
- Total recipients across `to`, `cc`, and `bcc` is ≤ 100.
- `subject` is required when `replyToMessageId` is absent.
- No header field (subject or addresses) may contain CR or LF characters, which prevents header injection.

**Behavior**

1. Authenticate, then load `gmail_accounts`.
2. If `replyToMessageId` is set, load that row (it must belong to the user) and set:
   - `In-Reply-To: <original rfc822_message_id>`
   - `References: <original references> <original rfc822_message_id>`
   - The subject is derived by the server, and any client-supplied `subject` is ignored. Gmail threads a reply only when the `Subject` matches the original.
     - If the original `subject` already starts with `Re:` (case-insensitive, after trimming), it is reused verbatim.
     - Otherwise it becomes `Re: <original subject>`.
     - A null original subject gives `Re:`.
   - `threadId = original thread_id`
3. Build an RFC 2822 MIME message:
   - If both bodies are present: `multipart/alternative` with `text/plain` and `text/html` parts.
   - Otherwise: a single part.
   - Encoding: UTF-8, with RFC 2047-encoded subject.
4. Call `users.messages.send({ userId: 'me', requestBody: { raw: base64url(mime), threadId? } })`.
5. Call `users.messages.get({ id: sent.id, format: 'full' })` and upsert the row.

**Response — `201 Created`**

```ts
interface SendMessageResponse {
  message: MessageDTO;   // the sent message (labelIds includes "SENT")
}
```

**Errors**

| Code | HTTP | Trigger |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No valid session. |
| `GMAIL_NOT_CONNECTED` | 409 | No `gmail_accounts` row or refresh token. |
| `GMAIL_TOKEN_REVOKED` | 401 | `invalid_grant`. |
| `VALIDATION_FAILED` | 400 | Body is not JSON, or it fails any rule above (`details.issues` lists them). |
| `MESSAGE_NOT_FOUND` | 404 | `replyToMessageId` is not in this user's `messages` rows. |
| `GMAIL_RATE_LIMITED` | 429 | Gmail rate limit. |
| `GMAIL_UPSTREAM_ERROR` | 502 | Gmail send/get returned 5xx or an unexpected 4xx. |
| `INTERNAL` | 500 | DB error or an unexpected exception. |

If `send` succeeds but the follow-up `get` or upsert fails, the endpoint still returns an error (`GMAIL_UPSTREAM_ERROR` or `INTERNAL`) with `details: { sentGmailId }`, so that the client does not resend. The next sync will pick up the message.

---

### 4.4 Mark as read — `POST /api/messages/{id}/read`

**Request**

```ts
// Path param
interface MarkReadParams {
  id: string;   // gmailId
}
// No body.
```

**Behavior**

1. Authenticate, then load `gmail_accounts`.
2. Load the row `(user_id, gmail_id = id)`. If it is missing → `MESSAGE_NOT_FOUND`.
3. Call `users.messages.modify({ id, requestBody: { removeLabelIds: ['UNREAD'] } })`. This is idempotent in Gmail.
4. Update `label_ids` from the modify response's `labelIds`, set `is_read = true`, and set `synced_at = now()`.

**Response — `200 OK`** (also returned when the message was already read)

```ts
interface MarkReadResponse {
  message: MessageDTO;   // isRead === true
}
```

**Errors**

| Code | HTTP | Trigger |
|---|---|---|
| `UNAUTHENTICATED` | 401 | No valid session. |
| `GMAIL_NOT_CONNECTED` | 409 | No `gmail_accounts` row or refresh token. |
| `GMAIL_TOKEN_REVOKED` | 401 | `invalid_grant`. |
| `MESSAGE_NOT_FOUND` | 404 | No row for this user and ID, or Gmail `modify` returned 404. In the Gmail 404 case the stale row is deleted. |
| `GMAIL_RATE_LIMITED` | 429 | Gmail rate limit. |
| `GMAIL_UPSTREAM_ERROR` | 502 | Gmail 5xx or an unexpected 4xx. |
| `INTERNAL` | 500 | DB error or an unexpected exception. |

---

### 4.5 Gmail push webhook — `POST /api/webhooks/gmail`

Receives Gmail change notifications from a Cloud Pub/Sub **push** subscription and applies the delta to the DB. Only Pub/Sub calls this endpoint; it is not user-facing.

**Prerequisites (deployment config, env)**

- A Pub/Sub topic `GMAIL_PUBSUB_TOPIC` (`projects/<p>/topics/<t>`) with publish rights granted to `gmail-api-push@system.gserviceaccount.com`.
- A push subscription to this URL with OIDC authentication enabled, configured by:
  - `PUBSUB_PUSH_AUDIENCE`: the expected `aud` of the token.
  - `PUBSUB_PUSH_SERVICE_ACCOUNT`: the expected `email` of the token.

**Watch registration and renewal** (no cron)

- `MailProvider.watch()` calls `users.watch({ topicName: GMAIL_PUBSUB_TOPIC, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' })`. It stores the response's `expiration` in `gmail_accounts.watch_expiration`.
- It is called:
  - at the end of a successful OAuth callback (§4.1);
  - on any authenticated request (§4.2–§4.4) when `watch_expiration` is null or less than 24 h away.
- Gmail requires renewal at least every 7 days. A failed renewal is logged and never fails the user's request.

**Request** — `Content-Type: application/json`

The request carries the header `Authorization: Bearer <Google-signed OIDC JWT>`. Its body:

```ts
interface PubSubPushBody {
  message: {
    data: string;          // base64url JSON: { emailAddress: string; historyId: string }
    messageId: string;     // Pub/Sub ID, unrelated to Gmail message IDs
    publishTime: string;
  };
  subscription: string;
}
```

**Behavior**

1. Verify the OIDC token with `google-auth-library`. The only exception is the local-replay flag below.
   - **Local replay flag.** `PUBSUB_VERIFY_DISABLED=true` skips this step. It takes effect only when `NODE_ENV === 'development'` and `VERCEL_ENV` is unset or `development`. If the flag is set anywhere else, every webhook request fails closed with `500 INTERNAL` and an error log line.

   Verification itself uses `OAuth2Client.verifyIdToken`. `aud` must equal `PUBSUB_PUSH_AUDIENCE`, `email` must equal `PUBSUB_PUSH_SERVICE_ACCOUNT`, and `email_verified` must be true. Otherwise → `UNAUTHENTICATED`.
2. Decode `message.data` into `{ emailAddress, historyId }`. If it fails → `VALIDATION_FAILED`.
3. Look up `gmail_accounts` by `email = emailAddress`. If there is no row, or no refresh token → **ack** (`204`) and make no Gmail call.
4. **Delta rule:**
   - If `historyId` ≤ `last_history_id` (compared as unsigned 64-bit integers via `BigInt`), the notification is a duplicate or arrived out of order → ack, no Gmail call.
   - Otherwise run the same incremental sync as §4.2 starting from the **stored** `last_history_id`, never from the notification's `historyId`. The notification's ID is the mailbox's *new* state and is used only as the "is there anything newer?" test.
   - The 404 fallback to full sync applies here too.
5. `last_history_id` only ever advances: `UPDATE … SET last_history_id = $new WHERE last_history_id IS NULL OR last_history_id::numeric < $new::numeric`. This makes concurrent syncs (webhook and list) safe. Each sync runs under `pg_advisory_xact_lock(hashtext(user_id::text))`.

**Response**

| Outcome | Status | Body |
|---|---|---|
| Processed, duplicate, or unknown mailbox | `204 No Content` | none (acks the message) |
| Error | per table below | §3.3 envelope |

Pub/Sub redelivers on any non-2xx status, so only retryable failures return non-2xx.

**Errors**

| Code | HTTP | Trigger |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing or invalid OIDC token, or wrong `aud`/`email`. |
| `VALIDATION_FAILED` | 400 | Body not JSON, or `message.data` does not decode to `{ emailAddress, historyId }`. |
| `GMAIL_RATE_LIMITED` | 429 | Gmail rate limit during sync. Pub/Sub retries with backoff. |
| `SYNC_FAILED` | 502 | Any other Gmail failure during sync. |
| `INTERNAL` | 500 | DB error or an unexpected exception. |

A `GMAIL_TOKEN_REVOKED` during a webhook sync is **acked** (`204`): retrying cannot succeed. The account's `refresh_token`, `access_token` and `access_token_expires_at` are then set to `null`, so later user requests return `GMAIL_NOT_CONNECTED`.

---

## 5. Data model

### 5.1 `messages` — one stored message

Source is the Gmail `users.messages.get` response with `format=full` (the `Message` resource, referred to below as `m`).

| Column | Postgres type | TS type | Nullable | Source |
|---|---|---|---|---|
| `id` | `uuid` PK, `default gen_random_uuid()` | `string` | no | Generated |
| `user_id` | `uuid` FK → `auth.users(id)` on delete cascade | `string` | no | Supabase session (`auth.uid()`) |
| `gmail_id` | `text` | `string` | no | `m.id` |
| `thread_id` | `text` | `string` | no | `m.threadId` |
| `label_ids` | `text[]` | `string[]` | no (default `{}`) | `m.labelIds` (absent → `[]`) |
| `is_read` | `boolean` | `boolean` | no | Derived: `!m.labelIds.includes('UNREAD')` |
| `snippet` | `text` | `string` | no (default `''`) | `m.snippet` |
| `history_id` | `text` | `string` | no | `m.historyId` (uint64, stored as text to avoid precision loss) |
| `internal_date` | `timestamptz` | `string` (ISO) | no | `m.internalDate` (epoch-ms string → `new Date(Number(v))`) |
| `size_estimate` | `integer` | `number` | no | `m.sizeEstimate` |
| `subject` | `text` | `string \| null` | yes | `m.payload.headers[name="Subject"].value` |
| `from_address` | `text` | `string` | no (default `''`) | `m.payload.headers[name="From"].value` (raw, e.g. `Ada <ada@x.io>`) |
| `to_addresses` | `text[]` | `string[]` | no (default `{}`) | `m.payload.headers[name="To"].value`, split into addresses |
| `cc_addresses` | `text[]` | `string[]` | no (default `{}`) | `m.payload.headers[name="Cc"].value`, split |
| `bcc_addresses` | `text[]` | `string[]` | no (default `{}`) | `m.payload.headers[name="Bcc"].value`, split (present on sent mail only) |
| `rfc822_message_id` | `text` | `string \| null` | yes | `m.payload.headers[name="Message-ID"].value` |
| `in_reply_to` | `text` | `string \| null` | yes | `m.payload.headers[name="In-Reply-To"].value` |
| `references` | `text` | `string \| null` | yes | `m.payload.headers[name="References"].value` |
| `date_header` | `text` | `string \| null` | yes | `m.payload.headers[name="Date"].value` (raw, unparsed) |
| `body_text` | `text` | `string \| null` | yes | First part (depth-first) with `mimeType = "text/plain"` and no `filename`: `body.data`, base64url-decoded as UTF-8 |
| `body_html` | `text` | `string \| null` | yes | First part (depth-first) with `mimeType = "text/html"` and no `filename`: `body.data`, base64url-decoded as UTF-8 |
| `attachments` | `jsonb` | `AttachmentMeta[]` | no (default `[]`) | Every part with a non-empty `filename` and `body.attachmentId`: `{ partId: part.partId, filename: part.filename, mimeType: part.mimeType, size: part.body.size, attachmentId: part.body.attachmentId }` |
| `synced_at` | `timestamptz` | `string` | no | Server time of the last write from Gmail |
| `created_at` | `timestamptz` default `now()` | `string` | no | Server time |
| `updated_at` | `timestamptz` default `now()` | `string` | no | Server time (trigger on update) |

Parsing rules:

- Header lookup is case-insensitive on `name`. If a header repeats, the first occurrence wins.
- MIME parts are walked recursively through `payload.parts`. A single-part message carries its body directly in `payload.body.data`.

Constraints and indexes:

- `UNIQUE (user_id, gmail_id)`. This is the upsert conflict target.
- `INDEX (user_id, internal_date DESC, gmail_id DESC)`, used for list pagination.
- RLS enabled. Policies allow `SELECT`/`INSERT`/`UPDATE`/`DELETE` only `USING (user_id = auth.uid())` / `WITH CHECK (user_id = auth.uid())`.

### 5.2 `gmail_accounts` — supporting table

| Column | Postgres type | Nullable | Source |
|---|---|---|---|
| `user_id` | `uuid` PK, FK → `auth.users(id)` on delete cascade | no | Session |
| `email` | `text` | no | `session.user.email` |
| `refresh_token` | `text` (encrypted via Supabase Vault / pgsodium) | no | `session.provider_refresh_token` |
| `scopes` | `text[]` | no | Granted scopes from token info |
| `access_token` | `text` (encrypted like `refresh_token`) | yes | Callback: `session.provider_token`. Afterwards: `tokens.access_token` from the `'tokens'` event |
| `access_token_expires_at` | `timestamptz` | yes | Callback: `now() + expires_in` from token info. Afterwards: `tokens.expiry_date` (epoch ms) from the `'tokens'` event |
| `last_history_id` | `text` | yes | Max `historyId` after the last successful sync; `null` forces a full sync |
| `last_synced_at` | `timestamptz` | yes | Server time |
| `watch_expiration` | `timestamptz` | yes | `users.watch` response `expiration` (epoch-ms string); `null` means no active watch |
| `created_at` / `updated_at` | `timestamptz` | no | Server time |

RLS is the same as `messages`. Neither `refresh_token` nor `access_token` is ever returned by any endpoint.

`CHECK ((access_token IS NULL) = (access_token_expires_at IS NULL))` enforces the pairing rule from §3.1.

`UNIQUE (email)` exists so the webhook can look accounts up by email. The webhook has no user session, so it runs with the Supabase service-role key. That key is server-only, and the webhook is the only code path that uses it.

---

## 6. Sequencing rule — two-session build

**Rule: server logic ships and its tests pass *before* the schema is reviewed or merged.**

### Session 1 — server logic

1. Build the route handlers (§4), the Gmail client wrapper, MIME parse/build, sync, the error mapping (§3.3), and a repository layer that holds all SQL.
2. Write `supabase/migrations/<timestamp>_draft_vibemail.sql`, implementing §5 as written. The file's header comment is `-- DRAFT: not reviewed; see CONTRACT.md §6`. The migration is applied **only** to local Supabase (`supabase start` / `supabase db reset`).
3. **Gate 1** (all of these must hold before Session 1 can end):
   - `vitest run` is green (unit + local-Supabase integration).
   - `tsc --noEmit` is green.
   - Lint is green.
   - Server-logic changes are merged.
   - The draft migration is **not** merged and **not** pushed to any remote Supabase project.

### Session 2 — schema

1. Review the draft migration line by line against §5: every column, type, nullability, default, constraint, index, and RLS policy.
2. Any discrepancy is resolved by changing **either** the migration **or** §5 (per §7), never by leaving them different.
3. If the migration changes at all, re-run the full Session 1 suite. **Gate 2:** it must be green.
4. Remove the `DRAFT` marker, merge the migration, and only then apply it to a remote Supabase project.

### Forbidden

- Reviewing, merging, or applying the schema to a remote project before Gate 1 has passed.
- Changing endpoint contracts (§4) during Session 2. A required change sends the work back to Session 1.

---

## 7. Change control

- Any change to an endpoint shape, an `ErrorCode`, or a §5 field is made in this file first, in the same PR as the code.
- The PR description names the changed section.
- Adding an `ErrorCode` requires updating the §3.3 table and adding the test required by §2, criterion 2.
