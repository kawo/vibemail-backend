import { ApiError } from '../middleware/errors';
import { requireUser } from '../middleware/auth';
import { issueState, verifyState } from '../middleware/oauthState';
import { toMessageDTO } from '../messages/dto';
import { listMessages, parseListQuery } from '../messages/list';
import { markMessageRead } from '../messages/markRead';
import { CONSENT_SCOPES } from '../providers/gmail/auth';
import { sendForUser } from '../send';
import { connectGmailAccount } from '../services/gmailAccount';
import { handleGmailPush } from '../webhook/gmail';
import type { AppDeps } from './deps';
import { corsHeaders, errorResponse, jsonResponse, preflightResponse, toApiError } from './respond';

/**
 * HTTP handlers for every function under `api/` (CONTRACT.md §4). Each `api/` file only binds
 * one of these to an exported method. `getDeps` is called per request, so a missing env
 * variable becomes a `500 INTERNAL` envelope instead of a crash at import time.
 */

type Handler = (request: Request) => Promise<Response>;

export interface Handlers {
  options: Handler;
  startConnect: Handler;
  oauthCallback: Handler;
  listMessages: Handler;
  sendMessage: Handler;
  markRead: Handler;
  gmailWebhook: Handler;
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

    startConnect: authenticated(async (deps, user) => {
      const { state, expiresAt } = issueState({ sub: user.userId, email: user.email }, deps.jwtSecret, deps.now());
      const authorizationUrl = deps.factory.buildAuthorizationUrl({
        state,
        scopes: CONSENT_SCOPES,
        loginHint: user.email,
      });
      return jsonResponse({ authorizationUrl, expiresAt: expiresAt.toISOString() }, 200);
    }),

    async oauthCallback(request) {
      let deps: AppDeps;
      try {
        deps = getDeps();
      } catch (error) {
        return errorResponse(toApiError(error));
      }
      const target = new URL('/settings/gmail', deps.frontendUrl);
      const redirect = (params: Record<string, string>): Response => {
        for (const [name, value] of Object.entries(params)) {
          target.searchParams.set(name, value);
        }
        return new Response(null, { status: 302, headers: { Location: target.toString(), 'Cache-Control': 'no-store' } });
      };

      try {
        const query = new URL(request.url).searchParams;
        const state = verifyState(query.get('state'), deps.jwtSecret, deps.now());
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
        const result = await connectGmailAccount(
          { factory: deps.factory, users: deps.users, messages: deps.messages, log: deps.log },
          { userId: state.sub, expectedEmail: state.email, code },
        );
        return redirect({ status: 'connected', initialSync: result.initialSync });
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
  };
}
