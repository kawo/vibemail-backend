import { MissingEnvError } from '../config/env';
import { ApiError, type ErrorCode } from '../middleware/errors';
import { ProviderError } from '../providers/provider';
import { apiErrorFromProvider } from '../services/gmailAccount';

/** HTTP status and default `retryable` per code, CONTRACT.md §3.3. */
export const ERROR_STATUS: Record<ErrorCode, { status: number; retryable: boolean }> = {
  UNAUTHENTICATED: { status: 401, retryable: false },
  GMAIL_NOT_CONNECTED: { status: 409, retryable: false },
  GMAIL_TOKEN_REVOKED: { status: 401, retryable: false },
  VALIDATION_FAILED: { status: 400, retryable: false },
  MESSAGE_NOT_FOUND: { status: 404, retryable: false },
  GMAIL_RATE_LIMITED: { status: 429, retryable: true },
  GMAIL_UPSTREAM_ERROR: { status: 502, retryable: true },
  SYNC_FAILED: { status: 502, retryable: true },
  METHOD_NOT_ALLOWED: { status: 405, retryable: false },
  CONFIG_ERROR: { status: 500, retryable: false },
  INTERNAL: { status: 500, retryable: false },
};

const BASE_HEADERS = { 'Cache-Control': 'no-store' } as const;

/** Normalizes any thrown value to an `ApiError`. Unknown failures become `INTERNAL` with a generic message. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof ProviderError) {
    return apiErrorFromProvider(error);
  }
  if (error instanceof MissingEnvError) {
    return new ApiError('INTERNAL', 'server is not configured');
  }
  return new ApiError('INTERNAL', 'internal error');
}

/** As `toApiError`, but missing configuration becomes `CONFIG_ERROR` (the OAuth endpoints, CONTRACT.md §4.1). */
export function toOAuthApiError(error: unknown): ApiError {
  if (error instanceof MissingEnvError) {
    return new ApiError('CONFIG_ERROR', 'server is not configured');
  }
  return toApiError(error);
}

/** The §3.3 envelope: `{ error: { code, message, retryable, details? } }`. */
export function errorResponse(error: ApiError, extraHeaders: Record<string, string> = {}): Response {
  const { status, retryable } = ERROR_STATUS[error.code];
  const headers: Record<string, string> = { ...BASE_HEADERS, ...extraHeaders };
  if (error.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(error.retryAfterSeconds);
  }
  return Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        retryable,
        ...(error.details ? { details: error.details } : {}),
      },
    },
    { status, headers },
  );
}

export function jsonResponse(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...BASE_HEADERS, ...extraHeaders } });
}

/** CORS for `/api/v1` (CONTRACT.md §3.2): exactly one origin, no credentials. */
export function corsHeaders(frontendUrl: string | undefined): Record<string, string> {
  if (!frontendUrl) {
    return {};
  }
  return { 'Access-Control-Allow-Origin': new URL(frontendUrl).origin, Vary: 'Origin' };
}

export function preflightResponse(frontendUrl: string | undefined): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(frontendUrl),
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    },
  });
}
