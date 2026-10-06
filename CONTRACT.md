# VibeMail Engine — Contract

> Status: **v1, binding.** Any change to an endpoint, error code, or stored field is made in this file first (see §7).
> Stack: Vercel Functions (Node.js runtime, `api/` directory, no framework) · TypeScript · Supabase (Postgres + Auth) · `googleapis` (Gmail API v1).

---

## 1. Purpose & scope

The VibeMail Engine is the backend that connects a user's Gmail account, mirrors their mail into Supabase, and exposes four user-facing endpoints (OAuth callback, message list, message send, mark as read) plus two machine-facing endpoints (the Gmail Pub/Sub webhook and the watch-renewal cron job).

**In scope (v1)**

- Google sign-in through Supabase Auth with offline access to Gmail.
- Gmail → DB sync (§3.5), **push-driven only**. Gmail is never polled.
  - An initial full sync runs when the account is connected (§4.1).
  - Every later sync is triggered by a Gmail push notification (Pub/Sub webhook, §4.5).
- Gmail `users.watch` registration at sign-in (§4.5) and daily renewal by a Vercel Cron Job (§4.6).
- Listing INBOX messages from the DB with cursor pagination.
- Sending new messages and replies (plain text and/or HTML).
- Marking a single message as read.

**Out of scope (v1)**

- Attachments on send (stored attachment *metadata* on received mail is in scope).
- Label/unread filters, search, and thread-grouped views.
- Scheduled jobs other than watch renewal. In particular, there is no scheduled or request-triggered sync: Gmail is read only at connect time and on push.
- Mark as unread, archive, delete, and batch operations.
- Multiple Gmail accounts per user.

---

## 2. Acceptance criteria

The project is complete when **every** item below is true and verifiable.

1. All six routes exist at the exact paths in §4 and accept/return exactly the shapes defined there.
2. Every `ErrorCode` listed in an endpoint's error table has at least one Jest test that triggers it and asserts the HTTP status and the error envelope from §3.3.
3. `jest --ci --runInBand` passes (TypeScript via `ts-jest`, TypeScript pinned to 6.x because `ts-jest` does not support 7), including integration tests running against local Supabase (`supabase start`) with the `schema` branch's migration applied, in the §6 Gate 1 worktree.
4. `npm run typecheck` (`tsc -p tsconfig.check.json`, covering `src/`, `api/` and `tests/`) passes with `strict: true`, and lint passes with zero errors.
5. A fixture test maps a recorded Gmail `users.messages.get?format=full` response to a `messages` row that matches §5 field for field. It includes a nested `multipart/alternative` inside `multipart/mixed` and one attachment.
6. Sync is tested for: first sync (no stored `historyId` → full sync, which stores at most 50 messages even when the inbox holds more), incremental sync (`history.list`), and fallback (`history.list` returns HTTP 404 → full sync). `GET /api/v1/messages` makes zero Gmail API calls (asserted with a fake `MailProvider` that fails on any call).
7. Mark-as-read is idempotent: calling it twice on the same message returns `200` both times with `isRead: true`.
8. Sending with `threadId` passes it unchanged to `messages.send`, and the raw MIME carries the client's subject and no derived threading headers (asserted on the Gmail request). A `threadId` Gmail doesn't know returns `MESSAGE_NOT_FOUND`.
9. A Google `invalid_grant` on token refresh maps to `GMAIL_TOKEN_REVOKED` on every Gmail-backed endpoint, and clears the stored access token.
   Access-token persistence (§3.1) is tested:
   - a stored token more than 5 minutes from expiry is reused with no refresh call;
   - a token within 5 minutes of expiry is refreshed, and the new token and expiry are persisted;
   - writing an access token without an expiry is rejected by the DB.
10. The webhook is tested for these cases:
    - **Valid notification:** returns `200` before any provider call, then applies exactly the history delta since the stored `history_id`, and saves the last `history.list` page's `historyId`.
    - **Duplicate or stale notification:** a notification whose `historyId` is ≤ the stored one makes no Gmail calls.
    - **Bad or missing `token` query parameter:** rejected with `401`.
    - **Unknown mailbox:** acknowledged without any Gmail call.
    - **Watch renewal cron (§4.6):**
      - a request without the correct `CRON_SECRET` bearer is rejected with `401` and makes no Gmail call;
      - an authorized run calls `users.watch` once for every connected account whose watch is missing, expired or within 24 h of expiry, skips the rest, and updates `watch_expiration`;
      - one account failing (including `invalid_grant`) does not stop the others.
11. Tenant isolation is tested:
    - through every user-facing endpoint, user A cannot read or modify user B's `messages` or `users` rows;
    - every repository function takes `userId` and its query filters on it (§5.3);
    - a token signed with the wrong secret, or with a different `alg`, is rejected.
12. The sequencing rule in §6 was followed, and its gates are recorded in the PR descriptions.

---

## 3. Shared conventions

### 3.1 Authentication

- **No cookies.** Every `/api/v1` endpoint except the Google OAuth callback requires `Authorization: Bearer <Supabase access token>`. That includes `GET /api/v1/auth/google/start` (§4.1). The frontend gets the token from its own Supabase sign-in. The callback is a browser redirect from Google and can't carry a header, so it authenticates with the signed `state` issued by the start endpoint (§4.1).
  - **Verification.** The token is checked locally with `jsonwebtoken`, using `jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], audience: 'authenticated', issuer: SUPABASE_URL + '/auth/v1' })`.
    - The `algorithms` allow-list is mandatory. It blocks `alg: none` and algorithm-confusion attacks.
    - **Prerequisite:** the Supabase project must sign user tokens with the legacy shared secret (HS256). A project switched to asymmetric signing keys would make every request fail `UNAUTHENTICATED`.
    - Locally, the secret is the `JWT secret` printed by `supabase status`.
  - The caller's identity is `claims.sub` (the `user_id`) and `claims.email`.
  - A missing, malformed, expired or wrongly signed token → `UNAUTHENTICATED`.
  - Known limit: local verification does not see server-side sign-out, so a revoked session's token stays accepted until it expires (Supabase default: 1 h). This is accepted for v1.
  - **No anon key.** All DB access, for every endpoint, uses one server-only Supabase client created with `SUPABASE_SERVICE_ROLE_KEY`. This client bypasses RLS, so tenant isolation is enforced in code (§5.3).
- The webhook (§4.5) and the cron job (§4.6) take no user token; they authenticate with `GOOGLE_PUBSUB_VERIFICATION_TOKEN` and `CRON_SECRET` respectively.
- Gmail calls use a `googleapis` `OAuth2` client built from the app's Google client ID/secret (env). Its credentials are seeded from `users`: `refresh_token`, `access_token`, and `expiry_date` (from `access_token_expires_at`, as epoch ms).
- **Access-token persistence.**
  - **Reuse.** The client reuses the stored access token until it is within 5 minutes of expiry, the library's default `eagerRefreshThresholdMillis`. Then it refreshes.
  - **Listener.** A `client.on('tokens')` listener persists every refresh:
    - `access_token` and `access_token_expires_at` are always written;
    - `refresh_token` is written only when Google returns a new one.
  - **Paired columns.** `access_token` and `access_token_expires_at` are always written together, or both set to `null`. `google-auth-library` treats a credential with no `expiry_date` as *never expiring*, so an access token stored without an expiry would never be refreshed. A DB `CHECK` enforces the pairing (§5.2).
  - **Revocation.** On `invalid_grant`, both access-token columns are set to `null`.
- **Gmail grant: backend OAuth.** The backend runs Google's authorization-code flow itself (§4.1): consent URL → `GET /api/v1/auth/google/callback` → code exchange. Supabase is used only for the user's own sign-in, not for Gmail tokens.
- Required Google scopes: `openid`, `email`, `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/gmail.send`. The consent URL uses `access_type=offline` and `prompt=consent`, so that Google returns a refresh token. Google's token info returns the account's `email` and `sub` only when the `email` scope was granted.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` configure every `OAuth2Client`.
  - The client is always constructed with the options object, `new OAuth2Client({ clientId, clientSecret, redirectUri })`, because the positional-argument form is deprecated in `google-auth-library` 11.
  - `GOOGLE_REDIRECT_URI` must be exactly `{origin}/api/v1/auth/google/callback`, and it must be registered as an authorized redirect URI on that Google OAuth client.
- **Revocation detection.** A refresh rejected for a revoked or invalid refresh token surfaces as a `GaxiosError` with `response.data.error === 'invalid_grant'`. That check is the only trigger for `GMAIL_TOKEN_REVOKED`.

### 3.2 Format

- **CORS.** Every `/api/v1` endpoint allows exactly one origin, `FRONTEND_URL`.
  - Responses carry `Access-Control-Allow-Origin: <FRONTEND_URL>` and `Vary: Origin`.
  - `OPTIONS` preflights get `204`, with `Access-Control-Allow-Methods: GET, POST`, `Access-Control-Allow-Headers: Authorization, Content-Type` and `Access-Control-Max-Age: 600`.
  - No credentials are allowed (there are no cookies).
  - The webhook and cron endpoints send no CORS headers.
- JSON request and response bodies use camelCase. DB columns use snake_case.
- Timestamps in JSON are ISO-8601 UTC strings (`2026-10-03T14:05:00.000Z`).
- Gmail IDs (`id`, `threadId`, `historyId`) are always strings.

### 3.3 Error envelope

Every error response, on every endpoint, has this shape.

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
| `UNAUTHENTICATED` | 401 | false | Missing or invalid bearer token, or an invalid OAuth `state` (§4.1b). |
| `GMAIL_NOT_CONNECTED` | 409 | false | The user has no `users` row, no refresh token, or is missing the required scopes. |
| `GMAIL_TOKEN_REVOKED` | 401 | false | Google rejected the refresh token (`invalid_grant`). The user must sign in again. |
| `VALIDATION_FAILED` | 400 | false | The request params or body failed validation. |
| `MESSAGE_NOT_FOUND` | 404 | false | The message ID is not in this user's mailbox (DB or Gmail). |
| `GMAIL_RATE_LIMITED` | 429 | true | Gmail returned 429 or a 403 `rateLimitExceeded`/`userRateLimitExceeded`. Sets the `Retry-After` header (seconds). |
| `GMAIL_UPSTREAM_ERROR` | 502 | true | Gmail returned 5xx or an unexpected 4xx. |
| `SYNC_FAILED` | 502 | true | Reserved. Webhook syncs run after the ack (§4.5), so their failures are logged, not returned. |
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
  isStarred: boolean;
  snippet: string;
  historyId: string;
  internalDate: string;          // ISO-8601
  sizeEstimate: number;
  subject: string | null;
  fromAddress: string;
  toAddress: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  rfc822MessageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  dateHeader: string | null;
  bodyPlain: string | null;
  bodyHtml: string | null;
  attachments: AttachmentMeta[];
  syncedAt: string;              // ISO-8601
}
```

### 3.5 Sync procedure

The procedure is shared by the connect endpoint (§4.1) and the webhook (§4.5); no other code path reads mail from Gmail. It runs under `pg_advisory_xact_lock(hashtext(user_id::text))`, and `history_id` only ever advances (§4.5, step 5).

- **Full sync** (when `history_id` is `null`, or on the 404 fallback): `users.messages.list({ labelIds: ['INBOX'], maxResults: 50 })`, paging with `pageToken` until 50 IDs are collected or the inbox is exhausted, so at most the 50 most recent INBOX messages. Then `users.messages.get({ format: 'full' })` each one and upsert it on `(user_id, gmail_id)`. A `get` that returns 404 is skipped. Finally, set `users.history_id` from the `historyId` of the newest fetched message, because `messages.list` responses carry no `historyId`.
- **Incremental sync** (otherwise): `users.history.list({ startHistoryId: history_id, historyTypes: ['messageAdded','messageDeleted','labelAdded','labelRemoved'] })`, paging until done.
  - History records carry only message `id`s (and `threadId`), so every change is applied as follows:
  - `messagesAdded` → `get` + upsert.
    - If `get` returns **404** (the message was deleted before the sync reached it), skip it and delete any stored row for that `gmail_id`. This is not an error.
  - `messagesDeleted` → delete the row (a no-op if there is none).
  - `labelsAdded` / `labelsRemoved` carry only the label IDs that changed, not the message's full label set:
    - **If the row exists:** apply the change to the stored `label_ids` (set union for added, set difference for removed), then recompute `is_read` and `is_starred`.
    - **If the row does not exist** (e.g. an older message beyond the initial 50 was moved into `INBOX`): `get` the message and upsert it, so its full, current label set is stored. A 404 there is skipped as above.
  - Records are applied in the order returned, so a later record wins.
  - Afterwards, set `history_id` to the response's `historyId`.
- **404 fallback.** If `history.list` returns **404** (the start ID is outside the retained history window), fall back to a full sync. Through the provider abstraction this surfaces as `ProviderError` with `kind: 'cursor_expired'` (`src/providers/provider.ts`).
- Both kinds set `users.last_synced_at = now()`.

### 3.6 Environment variables

| Variable | Used by |
|---|---|
| `SUPABASE_URL` | Every DB call; JWT issuer check (§3.1) |
| `SUPABASE_SERVICE_ROLE_KEY` | The single DB client (§3.1, §5.3) |
| `JWT_SECRET` | Bearer verification (§3.1) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | `OAuth2Client` (§3.1) |
| `GOOGLE_PUBSUB_TOPIC` | `users.watch` (§4.5) |
| `GOOGLE_PUBSUB_VERIFICATION_TOKEN` | Webhook authentication (§4.5) |
| `ENCRYPTION_KEY` | Token encryption (§5.4) |
| `FRONTEND_URL` | CORS (§3.2) |
| `CRON_SECRET` | Cron authentication (§4.6). The name is fixed by Vercel |

A missing required variable fails the function with `500 INTERNAL` and a log line naming the variable, never its value.

---

## 4. Endpoint contracts

### 4.1 Connect Gmail — backend OAuth flow

Two endpoints:
- **Start** (`GET /api/v1/auth/google/start`): the frontend `fetch`es it with the bearer, then sends the browser to the returned URL.
- **Callback** (`GET /api/v1/auth/google/callback`): Google redirects the browser there, and it redirects back to the frontend.

#### 4.1a Start — `GET /api/v1/auth/google/start`

**Request:** `Authorization: Bearer <Supabase access token>` (§3.1). No body or query.

**Behavior:** issue a signed `state`, then build the consent URL with `buildAuthorizationUrl` (scopes from §3.1, `access_type=offline`, `prompt=consent`, `login_hint = claims.email`).

**State format:** `base64url(JSON.stringify({ sub, email, exp, nonce }))` + `.` + `base64url(HMAC-SHA256(JWT_SECRET, payload))`, where:
- `sub` and `email` come from the bearer's claims;
- `exp` is now + 10 minutes (epoch seconds);
- `nonce` is 16 random bytes.

**Response — `200 OK`**

```ts
interface StartGmailConnectResponse {
  authorizationUrl: string;  // https://accounts.google.com/o/oauth2/v2/auth?...&state=...
  expiresAt: string;         // ISO-8601; when the state stops being accepted
}
```

**Errors:** `UNAUTHENTICATED` (401), `INTERNAL` (500).

#### 4.1b Callback — `GET /api/v1/auth/google/callback?code&state` (or `?error&state`)

No bearer: the signed `state` identifies the user. Every outcome is a **`302`** to the frontend:

| Outcome | `Location` |
|---|---|
| Connected | `{FRONTEND_URL}/settings/gmail?status=connected&initialSync=completed\|failed` |
| Any error | `{FRONTEND_URL}/settings/gmail?status=error&code=<ErrorCode>[&reason=<details.reason>]` |

**Behavior**

1. **Verify `state`.**
   - The HMAC is checked in constant time and `exp` must be in the future.
   - A missing, tampered or expired state → `UNAUTHENTICATED`.
   - This yields `user_id = sub` and `expectedEmail = email`.
2. **Handle denial.** If Google sent `error` (e.g. `access_denied`) instead of `code` → `GMAIL_NOT_CONNECTED` with `reason=<Google error>`. A missing `code` → `VALIDATION_FAILED`.
3. **Exchange the code** with `exchangeAuthorizationCode` (`OAuth2Client.getToken`), then call token info.
   - `invalid_grant` (expired or reused code) → `GMAIL_TOKEN_REVOKED`.
   - No refresh token returned → `GMAIL_NOT_CONNECTED`.
4. **Check identity.** Token info must have `email` and `sub`; otherwise → `GMAIL_NOT_CONNECTED` with `reason=missing_email_scope`. The email must equal `expectedEmail` (case-insensitive); otherwise → `VALIDATION_FAILED` with `reason=EMAIL_MISMATCH`.
   - This is the CSRF defence: a victim tricked into completing a flow started with an attacker's `state` authorizes the victim's own Google account, whose email doesn't match the attacker's.
5. **Check scopes.** If `gmail.modify` or `gmail.send` is missing → `GMAIL_NOT_CONNECTED` with `reason=missing_gmail_scope`.
6. **Upsert** `users` on conflict `google_id` (linking rules in §5.2) with `google_id` (token-info `sub`), `user_id`, `email`, `refresh_token`, `scopes`, and `access_token` / `access_token_expires_at` as a pair (§3.1). Reset `history_id` to `null` on re-connect (this forces a full sync). Linking conflicts → `VALIDATION_FAILED` with `reason=GOOGLE_ACCOUNT_LINKED_ELSEWHERE` or `ANOTHER_GOOGLE_ACCOUNT_LINKED`.
7. Call `MailProvider.watch()` (§4.5). If it fails, the failure is logged; it doesn't fail the connect.
8. Run the initial **full sync** (§3.5). If it fails, the failure is logged and `initialSync=failed`. `history_id` then stays `null`, so the next push notification runs the full sync instead.

**Error codes** (in the redirect's `code` parameter): `UNAUTHENTICATED`, `VALIDATION_FAILED`, `GMAIL_TOKEN_REVOKED`, `GMAIL_NOT_CONNECTED`, `GMAIL_RATE_LIMITED`, `GMAIL_UPSTREAM_ERROR`, `INTERNAL`.

If `FRONTEND_URL` itself is not configured, the callback answers `500` with the §3.3 envelope instead of redirecting.

---

### 4.2 Message list — `GET /api/v1/messages`

Returns INBOX messages from the DB, newest first. This endpoint **never calls Gmail**: the DB is kept current by push (§4.5).

**Request**

```ts
// Query string
interface ListMessagesQuery {
  limit?: number;   // integer 1..100, default 25
  cursor?: string;  // opaque; value of a previous response's nextCursor
}
```

**Behavior**

1. Authenticate (§3.1), then load `users` for the user.
2. **Query:** select rows `WHERE user_id = $userId AND 'INBOX' = ANY(label_ids)` (`$userId` from the verified token), ordered by `(internal_date DESC, gmail_id DESC)`, using keyset pagination from the cursor and `limit + 1` rows to compute `nextCursor`.

**Cursor:** `base64url(JSON.stringify({ d: internalDateISO, g: gmailId }))`. Clients treat it as opaque.

**Response — `200 OK`**

```ts
interface ListMessagesResponse {
  messages: MessageDTO[];      // length <= limit
  nextCursor: string | null;   // null when there are no more rows
  lastSyncedAt: string | null; // ISO-8601, users.last_synced_at; null if no sync has completed yet
}
```

**Errors**

| Code | HTTP | Trigger |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing or invalid bearer token. |
| `GMAIL_NOT_CONNECTED` | 409 | No `users` row, or `refresh_token` is `null` (never connected, or revoked). |
| `VALIDATION_FAILED` | 400 | `limit` not an integer in 1..100, or `cursor` fails to decode or has the wrong shape. |
| `INTERNAL` | 500 | DB error or an unexpected exception. |

---

### 4.3 Message send — `POST /api/v1/messages/send`

Sends a plain-text message through Gmail, optionally into an existing thread, then stores the sent message. Implemented in `src/send/index.ts`.

**Request** — `Content-Type: application/json`

```ts
interface SendMessageRequest {
  to: string | string[];  // one address or a list; >= 1, <= 100
  subject: string;        // may be ""; max 998 chars, no CR/LF
  body: string;           // plain text (text/plain; charset=UTF-8)
  threadId?: string;      // a Gmail thread ID in this user's mailbox, passed to Gmail as-is
}
```

Validation rules (`VALIDATION_FAILED` with `details.issues` listing every failure):

- Every address is a valid RFC 5322 addr-spec, or `Name <addr-spec>`, with no CR/LF.
- `subject` contains no CR or LF (header injection) and is at most 998 characters.
- `body` is a string. An empty body is allowed.
- `threadId`, when present, is a non-empty string of letters and digits.

**Behavior**

1. Authenticate (§3.1), then load the user's credentials and account email from `users`.
2. Build an RFC 2822 message (`src/providers/gmail/mime.ts`, behind `MailProvider.sendMessage`):
   - Headers: `From: <users.email>`, `To`, `Subject`, `Date`, `MIME-Version: 1.0`.
   - The subject is RFC 2047-encoded when it isn't ASCII.
   - The body is a single `text/plain; charset=UTF-8` part, base64 content-transfer-encoded.
   - Lines end in CRLF.
3. Call `users.messages.send({ userId: 'me', requestBody: { raw: base64url(mime), threadId? } })`.
   - `threadId` is passed through unchanged. No `In-Reply-To` / `References` headers are derived and the subject is not rewritten.
   - Gmail itself files the message in that thread, but recipients' mail clients may not thread it unless the subject matches.
4. `messages.send` returns only `id`, `threadId` and `labelIds`. So call `users.messages.get({ id, format: 'full' })`, normalize it with the same parser as sync (§5.1), and upsert the row on `(user_id, gmail_id)`.

**Response — `201 Created`**

```ts
interface SendMessageResponse {
  message: MessageDTO;   // the sent message (labelIds includes "SENT")
}
```

**Errors**

| Code | HTTP | Trigger |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing or invalid bearer token. |
| `GMAIL_NOT_CONNECTED` | 409 | No `users` row or refresh token. |
| `GMAIL_TOKEN_REVOKED` | 401 | `invalid_grant`. |
| `VALIDATION_FAILED` | 400 | Body is not JSON, or it fails any rule above (`details.issues` lists them). |
| `MESSAGE_NOT_FOUND` | 404 | Gmail rejected `threadId` as not found in this mailbox (`details: { threadId }`). |
| `GMAIL_RATE_LIMITED` | 429 | Gmail rate limit. |
| `GMAIL_UPSTREAM_ERROR` | 502 | Gmail send/get returned 5xx or an unexpected 4xx. |
| `INTERNAL` | 500 | DB error or an unexpected exception. |

If `send` succeeds but the follow-up `get` or upsert fails, the endpoint still returns an error (`GMAIL_UPSTREAM_ERROR` or `INTERNAL`) with `details: { sentGmailId }`, so that the client does not resend. The next sync will pick up the message.

---

### 4.4 Mark as read — `POST /api/v1/messages/{id}/read`

**Request**

```ts
// Path param
interface MarkReadParams {
  id: string;   // gmailId
}
// No body.
```

**Behavior**

1. Authenticate, then load `users`.
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
| `GMAIL_NOT_CONNECTED` | 409 | No `users` row or refresh token. |
| `GMAIL_TOKEN_REVOKED` | 401 | `invalid_grant`. |
| `MESSAGE_NOT_FOUND` | 404 | No row for this user and ID, or Gmail `modify` returned 404. In the Gmail 404 case the stale row is deleted. |
| `GMAIL_RATE_LIMITED` | 429 | Gmail rate limit. |
| `GMAIL_UPSTREAM_ERROR` | 502 | Gmail 5xx or an unexpected 4xx. |
| `INTERNAL` | 500 | DB error or an unexpected exception. |

---

### 4.5 Gmail push webhook — `POST /webhook/gmail`

Public path `/webhook/gmail`, outside `/api/v1`. The function file is `api/webhook/gmail.ts`, because Vercel serves functions only from `api/`. `vercel.json` maps the public path onto it:

```json
{ "rewrites": [{ "source": "/webhook/gmail", "destination": "/api/webhook/gmail" }] }
```

The Pub/Sub push subscription endpoint is `https://<host>/webhook/gmail`.

Receives Gmail change notifications from a Cloud Pub/Sub **push** subscription and applies the delta to the DB. Only Pub/Sub calls this endpoint; it is not user-facing.

**Prerequisites (deployment config, env)**

- `GOOGLE_PUBSUB_TOPIC`: a Pub/Sub topic (`projects/<p>/topics/<t>`) with publish rights granted to `gmail-api-push@system.gserviceaccount.com`.
- `GOOGLE_PUBSUB_VERIFICATION_TOKEN`: a random string of at least 32 characters, shared with Pub/Sub through the push URL.
- A push subscription whose endpoint is `https://<host>/webhook/gmail?token=<GOOGLE_PUBSUB_VERIFICATION_TOKEN>`. The `vercel.json` rewrite preserves the query string.

**Watch registration and renewal**

- `MailProvider.watch()` calls `users.watch({ topicName: GOOGLE_PUBSUB_TOPIC, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' })`. It stores the response's `expiration` in `users.watch_expiration`.
- It is called:
  - at the end of a successful OAuth callback (§4.1), so a new account receives push immediately;
  - once a day for every connected account, by the cron job in §4.6.
- Gmail requires renewal at least every 7 days and recommends once a day. User requests (§4.2–§4.4) never call `watch()`.

**Request** — `Content-Type: application/json`

The request URL carries `?token=<GOOGLE_PUBSUB_VERIFICATION_TOKEN>`. Its body:

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

1. **Verify the shared token.**
   - If `GOOGLE_PUBSUB_VERIFICATION_TOKEN` is unset or empty → `500 INTERNAL` (fail closed).
   - Compare the `token` query parameter to it in constant time (`crypto.timingSafeEqual` on equal-length buffers). If it is missing or doesn't match → `UNAUTHENTICATED`.
   - There is no bypass. A local replay simply sends the same `?token=` from `.env`.
   - Known limit: the token sits in the URL, so it can appear in access logs. Rotate it by updating the env var and the subscription endpoint together.
2. Decode `message.data` (base64 JSON) into `{ emailAddress, historyId }`. If it fails → `VALIDATION_FAILED`.
3. **Ack immediately.** Return `200` with an empty body, and hand steps 4–6 to `waitUntil` from `@vercel/functions`. That keeps the function alive after the response, up to the function's `maxDuration`. Everything after the ack is background work:
   - **Failures are logged and never retried by Pub/Sub**, because it has already been acked.
   - Nothing is lost: the next notification catches up, because every sync starts from the **stored** `history_id`.
   - Outside Vercel (tests, `vercel dev`), `waitUntil` is a no-op and the promise simply runs to completion.
4. Look up `users` by `email = emailAddress` (`findAccountByEmailUnscoped`). If there is no row, or no refresh token, stop with no Gmail call.
5. **Delta rule:**
   - If `historyId` ≤ `history_id` (compared as unsigned 64-bit integers via `BigInt`), the notification is a duplicate or arrived out of order → stop, no Gmail call.
   - If the stored `history_id` is `null` (the initial sync at connect failed), run a full sync (§3.5).
   - Otherwise run the incremental sync (§3.5) starting from the **stored** `history_id`, never from the notification's `historyId`. The notification's ID is the mailbox's *new* state and is used only as the "is there anything newer?" test.
   - The 404 fallback to full sync applies here too.
   - The saved `history_id` is the `historyId` of the **last `history.list` page**, saved only after every change was applied, never the notification's.
6. `history_id` only ever advances: `UPDATE … SET history_id = $new WHERE history_id IS NULL OR history_id::numeric < $new::numeric`. This makes concurrent syncs (webhook and list) safe. Each sync runs under `pg_advisory_xact_lock(hashtext(user_id::text))`.

**Response**

| Outcome | Status | Body |
|---|---|---|
| Valid token and body (acked; sync runs in the background) | `200 OK` | empty |
| Error | per table below | §3.3 envelope |

Only failures detected **before** the ack return non-2xx. Pub/Sub retries those, and they usually need a configuration fix.

**Errors** (before the ack only)

| Code | HTTP | Trigger |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing or wrong `token` query parameter. |
| `VALIDATION_FAILED` | 400 | Body not JSON, or `message.data` does not decode to `{ emailAddress, historyId }`. |
| `INTERNAL` | 500 | `GOOGLE_PUBSUB_VERIFICATION_TOKEN` not configured. |

**Background failures**, logged and not returned:
- **Rate limits, Gmail errors and DB errors:** the sync stops without saving `history_id`, so the next notification retries the same delta.
- **`invalid_grant`:** the account's `refresh_token`, `access_token` and `access_token_expires_at` are set to `null`, so later user requests return `GMAIL_NOT_CONNECTED`.

---

### 4.6 Watch-renewal cron job — `GET /api/cron/renew-watch`

A Vercel Cron Job, run once a day, that renews the Gmail push watch (§4.5) for every connected account whose watch is missing, expired, or expires within 24 hours. Only Vercel's scheduler calls this endpoint; it is not user-facing.

**Configuration**

- Function file: `api/cron/renew-watch.ts`, with its logic in `src/cron/renewWatch.ts`.
- `vercel.json`:

  ```json
  {
    "crons": [{ "path": "/api/cron/renew-watch", "schedule": "0 6 * * *" }],
    "functions": { "api/cron/renew-watch.ts": { "maxDuration": 300 } }
  }
  ```

- Env: `CRON_SECRET`, a random string of at least 32 characters. Vercel sends it as `Authorization: Bearer <CRON_SECRET>` on every cron invocation.
- Vercel runs cron jobs against production deployments only. On a preview or locally, trigger the job by hand with `vercel crons run /api/cron/renew-watch`, or by sending the bearer header yourself.

**Request**

The request has no body and no query parameters. The only header that matters is `Authorization: Bearer <CRON_SECRET>`.

**Behavior**

1. **Authenticate.** If `CRON_SECRET` is unset or empty → `500 INTERNAL` (fail closed: the job never runs unauthenticated). If the header is missing or doesn't match (constant-time comparison) → `UNAUTHENTICATED`.
2. **Select accounts.** Using `listConnectedAccountsUnscoped({ watchExpiringBefore: now + 24 h })` (§5.3), select every `users` row with a non-null `refresh_token` where `watch_expiration` is null or earlier than `now + 24 h`. That covers watches that are expiring soon, already expired after a missed run, or never registered because `watch()` failed at connect.
3. **Renew.** For each account, call `MailProvider.watch()` (`users.watch` on `GOOGLE_PUBSUB_TOPIC`) and store the new `watch_expiration`. Gmail returns no resource ID, so none is stored. Calls run with a concurrency limit of 5. Failures are per account, never fatal for the run:
   - `invalid_grant`: clear `refresh_token`, `access_token` and `access_token_expires_at`, as in §4.5, and count the account as `revoked`.
   - Stored tokens that cannot be decrypted (§5.4): treated like `invalid_grant`.
   - Rate limit or other Gmail error: log it, count the account as `failed`, and leave the existing `watch_expiration` unchanged. The next daily run retries it. Because only watches with less than 24 h left are renewed, a single missed run can let a watch lapse. Push then stops until the next run renews it, and sync catches up from the stored `history_id` (§3.5).
4. **Respond** with the counts.

**Response — `200 OK`** (also returned when some accounts failed)

```ts
interface RenewWatchesResponse {
  renewed: number;
  revoked: number;
  failed: number;
  durationMs: number;
}
```

**Errors**

| Code | HTTP | Trigger |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing or wrong `Authorization` bearer. |
| `INTERNAL` | 500 | `CRON_SECRET` not configured, or the account query fails. |

---

## 5. Data model

### 5.1 `messages` — one stored message

Source is the Gmail `users.messages.get` response with `format=full` (the `Message` resource, referred to below as `m`).

| Column | Postgres type | TS type | Nullable | Source |
|---|---|---|---|---|
| `id` | `uuid` PK, `default gen_random_uuid()` | `string` | no | Generated |
| `user_id` | `uuid` FK → `auth.users(id)` on delete cascade | `string` | no | `sub` claim of the verified bearer token (§3.1) |
| `gmail_id` | `text` | `string` | no | `m.id` |
| `thread_id` | `text` | `string` | no | `m.threadId` |
| `label_ids` | `text[]` | `string[]` | no (default `{}`) | `m.labelIds` (absent → `[]`) |
| `is_read` | `boolean` | `boolean` | no | Derived: `!m.labelIds.includes('UNREAD')` |
| `is_starred` | `boolean` | `boolean` | no | Derived: `m.labelIds.includes('STARRED')` |
| `snippet` | `text` | `string` | no (default `''`) | `m.snippet` |
| `history_id` | `text` | `string` | no | `m.historyId` (uint64, stored as text to avoid precision loss) |
| `internal_date` | `timestamptz` | `string` (ISO) | no | `m.internalDate` (epoch-ms string → `new Date(Number(v))`) |
| `size_estimate` | `integer` | `number` | no | `m.sizeEstimate` |
| `subject` | `text` | `string \| null` | yes | `m.payload.headers[name="Subject"].value` |
| `from_address` | `text` | `string` | no (default `''`) | `m.payload.headers[name="From"].value` (raw, e.g. `Ada <ada@x.io>`) |
| `to_address` | `text[]` | `string[]` | no (default `{}`) | `m.payload.headers[name="To"].value`, split into addresses. Named singular, but an array, because a message can have several recipients |
| `cc_addresses` | `text[]` | `string[]` | no (default `{}`) | `m.payload.headers[name="Cc"].value`, split |
| `bcc_addresses` | `text[]` | `string[]` | no (default `{}`) | `m.payload.headers[name="Bcc"].value`, split (present on sent mail only) |
| `rfc822_message_id` | `text` | `string \| null` | yes | `m.payload.headers[name="Message-ID"].value` |
| `in_reply_to` | `text` | `string \| null` | yes | `m.payload.headers[name="In-Reply-To"].value` |
| `references` | `text` | `string \| null` | yes | `m.payload.headers[name="References"].value` |
| `date_header` | `text` | `string \| null` | yes | `m.payload.headers[name="Date"].value` (raw, unparsed) |
| `body_plain` | `text` | `string \| null` | yes | First part (depth-first) with `mimeType = "text/plain"` and no `filename`: `body.data`, base64url-decoded as UTF-8. A single-part message (no `payload.parts`) uses `payload.body.data`, by `payload.mimeType` |
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
- RLS enabled with **no policies**. That denies all access through the anon and authenticated roles: the Data API is closed to clients, and only the service role, which bypasses RLS, can read or write. This is defence in depth; isolation itself is §5.3.

### 5.2 `users` — one connected Google account per user

| Column | Postgres type | Nullable | Source |
|---|---|---|---|
| `google_id` | `text` PK | no | Token-info `sub` of the connected Google account (§4.1). This is the upsert conflict target |
| `user_id` | `uuid` `UNIQUE`, FK → `auth.users(id)` on delete cascade | no | `sub` claim of the verified bearer token (§3.1) |
| `email` | `text` `UNIQUE` | no | `claims.email` of the bearer token (§4.1) |
| `refresh_token` | `text`: ciphertext (§5.4) | yes | `refresh_token` from the §4.1b code exchange (or Google's rotated one later); `null` after revocation (§4.5, §4.6) |
| `scopes` | `text[]` | no | Granted scopes from token info |
| `access_token` | `text`: ciphertext (§5.4) | yes | §4.1b: the code exchange's `access_token`. Afterwards: `tokens.access_token` from the `'tokens'` event |
| `access_token_expires_at` | `timestamptz` | yes | §4.1b: the code exchange's `expiry_date`. Afterwards: `tokens.expiry_date` (epoch ms) from the `'tokens'` event |
| `history_id` | `text` | yes | Max `historyId` after the last successful sync; `null` forces a full sync |
| `last_synced_at` | `timestamptz` | yes | Server time |
| `watch_expiration` | `timestamptz` | yes | `users.watch` response `expiration` (epoch-ms string); `null` means no active watch. Gmail's watch returns no resource ID, so none is stored |
| `created_at` / `updated_at` | `timestamptz` | no | Server time |

RLS is the same as `messages` (enabled, no policies). Neither `refresh_token` nor `access_token` is ever returned by any endpoint.

`CHECK ((access_token IS NULL) = (access_token_expires_at IS NULL))` enforces the pairing rule from §3.1.

**Linking rules.** The table is keyed by `google_id`, and every user-scoped query still filters on `user_id` (§5.3).
- **Connect upsert.** `INSERT … ON CONFLICT (google_id) DO UPDATE SET … WHERE users.user_id = EXCLUDED.user_id`.
  - If it affects zero rows, the Google account is already linked to a different VibeMail user → `VALIDATION_FAILED` with `details: { reason: 'GOOGLE_ACCOUNT_LINKED_ELSEWHERE' }`.
  - If the insert violates `UNIQUE (user_id)`, this user already has a different Google account connected → `VALIDATION_FAILED` with `details: { reason: 'ANOTHER_GOOGLE_ACCOUNT_LINKED' }`. Multiple or switched accounts are out of scope (§1).
- **Lookups by email.** `UNIQUE (email)` lets the webhook find accounts by email. The webhook and the cron job look accounts up without a user (by email, or all of them). These are the only queries allowed to omit the `user_id` filter (§5.3).

### 5.3 Tenant isolation

Every query runs as the service role, so RLS does not protect user data. The rules below do.

- All SQL lives in the repository layer (`src/db`). Function code never builds queries.
- Every repository function that touches `messages` or `users` on behalf of a user takes `userId: string` as a required parameter, and puts `user_id = $userId` in every `SELECT`, `UPDATE` and `DELETE`. Upserts filter on it too: `messages` conflicts on `(user_id, gmail_id)`, and `users` conflicts on `google_id` with the `WHERE users.user_id = EXCLUDED.user_id` guard (§5.2).
- `userId` comes only from the verified token's `sub` (§3.1). It is never read from the request body, query string or path.
- Exactly two functions may query without a `user_id` filter, and their names say so:
  - `findAccountByEmailUnscoped(email)`, for the webhook (§4.5);
  - `listConnectedAccountsUnscoped({ watchExpiringBefore })`, for the cron job (§4.6).
- `SUPABASE_SERVICE_ROLE_KEY` is server-only and never logged or returned.

### 5.4 Token encryption

OAuth tokens are encrypted in application code before they reach the database. They are never stored in plaintext.

- **Algorithm:** AES-256-GCM via Node `crypto`.
- **Key:** `ENCRYPTION_KEY`, 32 random bytes encoded as base64. Startup fails if it doesn't decode to exactly 32 bytes.
- **Stored form:** `v1:<iv b64>:<authTag b64>:<ciphertext b64>`, with a fresh 12-byte IV per write. The `v1` prefix allows key rotation later.
- **Columns:** `users.refresh_token` and `users.access_token`. Only `src/db/` encrypts and decrypts, and plaintext tokens never leave the server process.
- **Integrity:** a decryption failure (wrong key, or a tampered value) is treated as revoked: `GMAIL_TOKEN_REVOKED`.

---

## 6. Sequencing rule — two-session build

**Rule: the schema session cannot be merged until the server-logic tests pass, i.e. `npm test` (= `jest --ci --runInBand`) exits 0.**

### Ownership

| Session | Branch | Owns (may write) | Must not write |
|---|---|---|---|
| Server logic | `main` | `api/`, `src/` except `src/types/` (this includes `src/db/`), `tests/`, `vercel.json`, `package.json` | `supabase/migrations/`, `src/types/` |
| Schema | `schema` | `supabase/migrations/`, `src/types/` (DB row types and the §3.4 DTOs) | Everything else, **in particular `src/db/`** |

`supabase/migrations/` is the only directory the Supabase CLI applies, so that is where migrations live. With the Supabase GitHub integration enabled, merging to `main` runs them against production, which is why merging is gated.

### Order

1. **Schema session (draft).** On `schema`, write `supabase/migrations/<timestamp>_vibemail.sql` and `src/types/` implementing §5 and §3.4 exactly. Commit and push `schema`, but do **not** merge it or review it. Do not apply it to any remote Supabase project.
2. **Server session.** On `main`, build every unit of BUILD_SEQUENCE.md. Code imports types from `src/types/`. Because those files live only on `schema` until the merge, `main` on its own is not expected to typecheck. All verification runs on the integration check below.
3. **Gate 1, the integration check.** In a throwaway worktree, merge `schema` into `main` without pushing:

   ```bash
   git worktree add ../vibemail-gate main
   cd ../vibemail-gate
   git merge --no-ff --no-edit schema
   supabase db reset
   npm test
   npm run typecheck
   npm run lint
   ```

   Gate 1 passes only when `npm test` exits 0 (with `numFailedTests`, `numPendingTests` and `numTodoTests` all 0) and `tsc` and lint are clean. Then delete the worktree.
4. **Schema session (review + merge).** Review the migration line by line against §5: every column, type, nullability, default, constraint, index, and RLS setting (enabled, no policies). Resolve any discrepancy by changing **either** the migration **or** §5 (per §7), never by leaving them different. If anything on `schema` changed after Gate 1, re-run Gate 1. Only then merge `schema` into `main`.

### Forbidden

- Merging `schema` (or applying its migration to a remote project) before Gate 1 has passed on the current tips of both branches.
- Writing to `src/db/` (or anything else outside its ownership column) from the schema session, and writing to `supabase/migrations/` or `src/types/` from the server session.
- Changing endpoint contracts (§4) from the schema session. A required change goes back to the server session.

---

## 7. Change control

- Any change to an endpoint shape, an `ErrorCode`, or a §5 field is made in this file first, in the same PR as the code.
- The PR description names the changed section.
- Adding an `ErrorCode` requires updating the §3.3 table and adding the test required by §2, criterion 2.
