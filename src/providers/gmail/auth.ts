import { Auth, google } from 'googleapis';
import { requireEnv } from '../../config/env';
import { issueState } from '../../middleware/oauthState';
import {
  type AccountCredentials,
  type OnTokens,
  type SyncCursor,
  type TokenUpdate,
  type VerifiedGrant,
  type WatchResult,
  ProviderError,
} from '../provider';

/**
 * Gmail OAuth layer (BUILD_SEQUENCE.md unit 2). No DB access: refreshed tokens leave through
 * `OnTokens`, and the caller persists them (CONTRACT.md §5.3, §5.4).
 */

export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
/** The two Gmail scopes token info must report. `email` is checked through token info's `email`/`sub`. */
export const REQUIRED_GMAIL_SCOPES = [GMAIL_MODIFY_SCOPE, GMAIL_SEND_SCOPE] as const;
/** Scopes for a consent URL: Gmail plus identity (CONTRACT.md §3.1). */
export const CONSENT_SCOPES = ['openid', 'email', ...REQUIRED_GMAIL_SCOPES];

export interface GmailAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  pubsubTopic: string;
}

export function gmailAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GmailAuthConfig {
  return {
    clientId: requireEnv('GOOGLE_CLIENT_ID', env),
    clientSecret: requireEnv('GOOGLE_CLIENT_SECRET', env),
    redirectUri: requireEnv('GOOGLE_REDIRECT_URI', env),
    pubsubTopic: requireEnv('GOOGLE_PUBSUB_TOPIC', env),
  };
}

/** Always the options-object form; the positional constructor is deprecated in google-auth-library 11. */
export function createOAuthClient(config: GmailAuthConfig): Auth.OAuth2Client {
  return new google.auth.OAuth2({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
  });
}

/** Converts library credentials to a `TokenUpdate`, or null when the access token/expiry pair is incomplete. */
export function toTokenUpdate(tokens: Auth.Credentials): TokenUpdate | null {
  if (!tokens.access_token || !tokens.expiry_date) {
    // Never persist an access token without its expiry: the library would treat it as never-expiring.
    return null;
  }
  const update: TokenUpdate = {
    accessToken: tokens.access_token,
    accessTokenExpiresAt: new Date(tokens.expiry_date),
  };
  if (tokens.refresh_token) {
    update.refreshToken = tokens.refresh_token;
  }
  return update;
}

/**
 * An OAuth2 client bound to one account, with the token persistence listener installed.
 * Every refresh (automatic or forced) emits `'tokens'`; the listener hands it to `onTokens`
 * immediately. `pendingWrites()` lets callers await persistence before returning.
 */
export interface BoundOAuthClient {
  client: Auth.OAuth2Client;
  pendingWrites(): Promise<void>;
}

export function bindAccount(
  config: GmailAuthConfig,
  credentials: AccountCredentials,
  onTokens: OnTokens,
): BoundOAuthClient {
  const client = createOAuthClient(config);
  const seeded: Auth.Credentials = { refresh_token: credentials.refreshToken };
  // Seed the access token only as a complete pair (CONTRACT.md §3.1).
  if (credentials.accessToken && credentials.accessTokenExpiresAt) {
    seeded.access_token = credentials.accessToken;
    seeded.expiry_date = credentials.accessTokenExpiresAt.getTime();
  }
  client.setCredentials(seeded);

  let chain: Promise<void> = Promise.resolve();
  let failure: unknown = null;
  client.on('tokens', (tokens) => {
    const update = toTokenUpdate(tokens);
    if (!update) {
      return;
    }
    // Serialize writes so a rotated refresh token is never overwritten by an older update.
    chain = chain
      .then(() => onTokens(update))
      .catch((error: unknown) => {
        failure = error;
      });
  });

  return {
    client,
    async pendingWrites() {
      await chain;
      if (failure !== null) {
        const error = failure;
        failure = null;
        throw new ProviderError('upstream', 'failed to persist refreshed tokens', { cause: error });
      }
    },
  };
}

interface GoogleErrorShape {
  response?: {
    status?: number;
    headers?: Record<string, string | undefined> | { get?(name: string): string | null };
    data?: { error?: string | { errors?: Array<{ reason?: string }> } };
  };
}

function headerValue(shape: GoogleErrorShape, name: string): string | undefined {
  const headers = shape.response?.headers;
  if (!headers) {
    return undefined;
  }
  if ('get' in headers && typeof headers.get === 'function') {
    return headers.get(name) ?? undefined;
  }
  const record = headers as Record<string, string | undefined>;
  return record[name] ?? record[name.toLowerCase()];
}

/** Translates any googleapis / google-auth-library failure into a `ProviderError`. */
export function toProviderError(error: unknown, context: string): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }
  const shape = (typeof error === 'object' && error !== null ? error : {}) as GoogleErrorShape;
  const status = shape.response?.status;
  const data = shape.response?.data;
  const oauthError = typeof data?.error === 'string' ? data.error : undefined;
  const reasons =
    typeof data?.error === 'object' && data.error.errors ? data.error.errors.map((e) => e.reason) : [];

  if (oauthError === 'invalid_grant') {
    return new ProviderError('revoked', `${context}: refresh token rejected (invalid_grant)`, { cause: error });
  }
  if (
    status === 429 ||
    (status === 403 && (reasons.includes('rateLimitExceeded') || reasons.includes('userRateLimitExceeded')))
  ) {
    const retryAfter = Number(headerValue(shape, 'retry-after'));
    return new ProviderError('rate_limited', `${context}: rate limited`, {
      cause: error,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    });
  }
  if (status === 404) {
    return new ProviderError('not_found', `${context}: not found`, { cause: error });
  }
  return new ProviderError('upstream', `${context}: Google request failed`, { cause: error });
}

async function grantFromClient(
  client: Auth.OAuth2Client,
  fallbackRefreshToken: string | null,
): Promise<VerifiedGrant> {
  const { access_token: accessToken, expiry_date: expiryDate, refresh_token: rotated } = client.credentials;
  const refreshToken = rotated ?? fallbackRefreshToken;
  if (!accessToken || !expiryDate) {
    throw new ProviderError('upstream', 'Google returned no access token');
  }
  const info = await client.getTokenInfo(accessToken);
  return {
    accountId: info.sub ?? null,
    email: info.email ?? null,
    scopes: info.scopes,
    // Empty when Google returned none (consent without access_type=offline / prompt=consent).
    // Callers reject that as GMAIL_NOT_CONNECTED (CONTRACT.md §4.1b step 3).
    credentials: { refreshToken: refreshToken ?? '', accessToken, accessTokenExpiresAt: new Date(expiryDate) },
  };
}

/** Proves a refresh token with one refresh, then reads identity and scopes (CONTRACT.md §4.1 steps 3–5). */
export async function verifyRefreshToken(config: GmailAuthConfig, refreshToken: string): Promise<VerifiedGrant> {
  const client = createOAuthClient(config);
  client.setCredentials({ refresh_token: refreshToken });
  try {
    await client.refreshAccessToken();
    return await grantFromClient(client, refreshToken);
  } catch (error) {
    throw toProviderError(error, 'verifyRefreshToken');
  }
}

/** Consent URL for the backend OAuth flow (CONTRACT.md §4.1a). */
export function buildAuthorizationUrl(
  config: GmailAuthConfig,
  options: { state: string; scopes: string[]; loginHint?: string },
): string {
  return createOAuthClient(config).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: options.scopes,
    state: options.state,
    ...(options.loginHint ? { login_hint: options.loginHint } : {}),
  });
}

/**
 * Starts the redirect OAuth flow (CONTRACT.md §4.1c): signs a `state` for the user and builds the
 * consent URL. Reads its configuration from env and throws `MissingEnvError` when any is missing.
 */
export function initiateOAuth(
  user: { sub: string; email: string },
  options: { env?: NodeJS.ProcessEnv; now?: Date } = {},
): { url: string; state: string; expiresAt: Date } {
  const env = options.env ?? process.env;
  const stateSecret = requireEnv('JWT_SECRET', env);
  const config: GmailAuthConfig = {
    clientId: requireEnv('GOOGLE_CLIENT_ID', env),
    clientSecret: requireEnv('GOOGLE_CLIENT_SECRET', env),
    redirectUri: requireEnv('GOOGLE_REDIRECT_URI', env),
    // Not needed to build a consent URL.
    pubsubTopic: env.GOOGLE_PUBSUB_TOPIC ?? '',
  };
  const { state, expiresAt } = issueState(user, stateSecret, options.now);
  const url = buildAuthorizationUrl(config, { state, scopes: CONSENT_SCOPES, loginHint: user.email });
  return { url, state, expiresAt };
}

/** Exchanges an authorization code for tokens, then reads identity and scopes (CONTRACT.md §4.1b). */
export async function exchangeAuthorizationCode(config: GmailAuthConfig, code: string): Promise<VerifiedGrant> {
  const client = createOAuthClient(config);
  try {
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    return await grantFromClient(client, null);
  } catch (error) {
    throw toProviderError(error, 'exchangeAuthorizationCode');
  }
}

/** Forces a refresh on a bound client and waits until `onTokens` has persisted it. */
export async function refreshBoundAccessToken(bound: BoundOAuthClient): Promise<TokenUpdate> {
  let credentials: Auth.Credentials;
  try {
    ({ credentials } = await bound.client.refreshAccessToken());
  } catch (error) {
    throw toProviderError(error, 'refreshAccessToken');
  }
  await bound.pendingWrites();
  const update = toTokenUpdate(credentials);
  if (!update) {
    throw new ProviderError('upstream', 'refresh returned no access token or expiry');
  }
  return update;
}

/** Registers or renews the INBOX push watch (CONTRACT.md §4.5). Gmail returns no resource ID. */
export async function watchInbox(config: GmailAuthConfig, bound: BoundOAuthClient): Promise<WatchResult> {
  const gmail = google.gmail({ version: 'v1', auth: bound.client });
  try {
    const { data } = await gmail.users.watch({
      userId: 'me',
      requestBody: {
        topicName: config.pubsubTopic,
        labelIds: ['INBOX'],
        labelFilterBehavior: 'INCLUDE',
      },
    });
    await bound.pendingWrites();
    if (!data.historyId || !data.expiration) {
      throw new ProviderError('upstream', 'watch response lacks historyId or expiration');
    }
    return { cursor: data.historyId as SyncCursor, expiresAt: new Date(Number(data.expiration)) };
  } catch (error) {
    throw toProviderError(error, 'watch');
  }
}
