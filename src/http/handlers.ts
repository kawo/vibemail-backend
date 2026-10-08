import { renewWatches, verifyCronSecret } from '../cron/renewWatch';
import { ApiError } from '../middleware/errors';
import { requireUser } from '../middleware/auth';
import {
  STATE_COOKIE,
  clearStateCookie,
  readCookie,
  stateCookie,
  verifyState,
  verifyStateCookie,
} from '../middleware/oauthState';
import { toMessageDTO } from '../messages/dto';
import { listMessages, parseListQuery } from '../messages/list';
import { markMessageRead } from '../messages/markRead';
import { initiateOAuth } from '../providers/gmail/auth';
import { sendForUser } from '../send';
import { signInWithGoogle } from '../services/gmailAccount';
import { handleGmailPush } from '../webhook/gmail';
import type { AppDeps } from './deps';
import { corsHeaders, errorResponse, jsonResponse, preflightResponse, toApiError, toOAuthApiError } from './respond';

/**
 * HTTP handlers for every function under `api/` (CONTRACT.md §4). Each `api/` file only binds
 * one of these to an exported method. `getDeps` is called per request, so a missing env
 * variable becomes a `500 INTERNAL` envelope instead of a crash at import time.
 */

type Handler = (request: Request) => Promise<Response>;

export interface Handlers {
  options: Handler;
  /** `GET /api/v1/auth/google`: 302 to Google sign-in (CONTRACT.md §4.1a). */
  startSignIn: Handler;
  oauthCallback: Handler;
  /** Any non-GET method on the OAuth endpoints (CONTRACT.md §4.1). */
  oauthMethodNotAllowed: Handler;
  listMessages: Handler;
  sendMessage: Handler;
  markRead: Handler;
  gmailWebhook: Handler;
  renewWatch: Handler;
}

export function createHandlers(getDeps: () => AppDeps): Handlers {
  /** Bearer-protected `/api/v1` handler: CORS on every response, §3.3 envelope on every error. */
  const authenticated =
    (run: (deps: AppDeps, user: { userId: string; email: string }, request: Request) => Promise<Response>): Handler =>
    async (request) => {
      let cors: Record<string, string> = {};
      try {
        const deps = getDeps();
        cors = corsHeaders(deps.frontendUrl);
        const user = requireUser(request, { jwtSecret: deps.jwtSecret, supabaseUrl: deps.supabaseUrl });
        const response = await run(deps, user, request);
        for (const [name, value] of Object.entries(cors)) {
          response.headers.set(name, value);
        }
        return response;
      } catch (error) {
        const apiError = toApiError(error);
        if (apiError.code === 'INTERNAL') {
          console.error('request failed', error instanceof Error ? error.message : error);
        }
        return errorResponse(apiError, cors);
      }
    };

  const methodNotAllowed = (): Response =>
    errorResponse(new ApiError('METHOD_NOT_ALLOWED', 'only GET is allowed'), { Allow: 'GET' });

  const readJson = async (request: Request): Promise<unknown> => {
    try {
      return await request.json();
    } catch {
      throw new ApiError('VALIDATION_FAILED', 'body must be JSON');
    }
  };

  return {
    async options() {
      let frontendUrl: string | undefined;
      try {
        frontendUrl = getDeps().frontendUrl;
      } catch {
        frontendUrl = undefined;
      }
      return preflightResponse(frontendUrl);
    },

    async startSignIn(request) {
      if (request.method !== 'GET') {
        return methodNotAllowed();
      }
      try {
        const deps = getDeps();
        const { url, nonce } = initiateOAuth({ now: deps.now() });
        const headers = new Headers({ Location: url, 'Cache-Control': 'no-store' });
        headers.append('Set-Cookie', stateCookie(nonce));
        return new Response(null, { status: 302, headers });
      } catch (error) {
        const apiError = toOAuthApiError(error);
        if (apiError.code === 'INTERNAL' || apiError.code === 'CONFIG_ERROR') {
          console.error('Google sign-in start failed', error instanceof Error ? error.message : error);
        }
        return errorResponse(apiError);
      }
    },

    async oauthMethodNotAllowed() {
      return methodNotAllowed();
    },

    async oauthCallback(request) {
      if (request.method !== 'GET') {
        return methodNotAllowed();
      }
      let deps: AppDeps;
      try {
        deps = getDeps();
      } catch (error) {
        const apiError = toOAuthApiError(error);
        console.error('OAuth callback failed', error instanceof Error ? error.message : error);
        return errorResponse(apiError);
      }
      const target = new URL('/auth/callback', deps.frontendUrl);
      /** Status in the query; session tokens only in the fragment, which never reaches a server or log. */
      const redirect = (params: Record<string, string>, fragment?: Record<string, string>): Response => {
        for (const [name, value] of Object.entries(params)) {
          target.searchParams.set(name, value);
        }
        if (fragment) {
          target.hash = new URLSearchParams(fragment).toString();
        }
        const headers = new Headers({ Location: target.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        headers.append('Set-Cookie', clearStateCookie());
        return new Response(null, { status: 302, headers });
      };

      try {
        const query = new URL(request.url).searchParams;
        const state = verifyState(query.get('state'), deps.jwtSecret, deps.now());
        verifyStateCookie(state, readCookie(request, STATE_COOKIE));
        const googleError = query.get('error');
        if (googleError) {
          throw new ApiError('GMAIL_NOT_CONNECTED', 'Google consent was not granted', {
            details: { reason: googleError },
          });
        }
        const code = query.get('code');
        if (!code) {
          throw new ApiError('VALIDATION_FAILED', 'missing authorization code');
        }
        const result = await signInWithGoogle(
          { factory: deps.factory, users: deps.users, messages: deps.messages, sessions: deps.sessions, log: deps.log },
          { code },
        );
        const { session } = result;
        return redirect(
          { status: 'signed_in', initialSync: result.initialSync },
          {
            access_token: session.accessToken,
            refresh_token: session.refreshToken,
            expires_in: String(session.expiresIn),
            expires_at: String(session.expiresAt),
            token_type: 'bearer',
          },
        );
      } catch (error) {
        const apiError = toApiError(error);
        if (apiError.code === 'INTERNAL') {
          deps.log('OAuth callback failed', error);
        }
        const reason = apiError.details?.reason;
        return redirect({
          status: 'error',
          code: apiError.code,
          ...(typeof reason === 'string' ? { reason } : {}),
        });
      }
    },

    listMessages: authenticated(async (deps, user, request) => {
      const query = parseListQuery(new URL(request.url));
      return jsonResponse(await listMessages(deps, user.userId, query), 200);
    }),

    sendMessage: authenticated(async (deps, user, request) => {
      const row = await sendForUser(deps, user.userId, await readJson(request));
      return jsonResponse({ message: toMessageDTO(row) }, 201);
    }),

    markRead: authenticated(async (deps, user, request) => {
      // Path: /api/v1/messages/{id}/read
      const segments = new URL(request.url).pathname.split('/').filter(Boolean);
      const at = segments.indexOf('messages');
      const raw = at >= 0 ? segments[at + 1] : undefined;
      let id = '';
      try {
        id = raw ? decodeURIComponent(raw) : '';
      } catch {
        id = '';
      }
      if (!id) {
        throw new ApiError('VALIDATION_FAILED', 'missing message id', {
          details: { issues: [{ field: 'id', message: 'required' }] },
        });
      }
      const row = await markMessageRead(deps, user.userId, id);
      return jsonResponse({ message: toMessageDTO(row) }, 200);
    }),

    async gmailWebhook(request) {
      let deps: AppDeps;
      try {
        deps = getDeps();
      } catch (error) {
        return errorResponse(toApiError(error));
      }
      return handleGmailPush(request, {
        factory: deps.factory,
        users: deps.users,
        messages: deps.messages,
        verificationToken: deps.pubsubVerificationToken,
        waitUntil: deps.waitUntil,
        log: deps.log,
      });
    },

    /** Vercel Cron, CONTRACT.md §4.6. No CORS: only Vercel's scheduler calls it. */
    async renewWatch(request) {
      try {
        const deps = getDeps();
        verifyCronSecret(request.headers.get('authorization'), deps.cronSecret);
        const result = await renewWatches({ factory: deps.factory, users: deps.users, now: deps.now, log: deps.log });
        return jsonResponse(result, 200);
      } catch (error) {
        const apiError = toApiError(error);
        if (apiError.code === 'INTERNAL') {
          console.error('cron renew-watch failed', error instanceof Error ? error.message : error);
        }
        return errorResponse(apiError);
      }
    },
  };
}
