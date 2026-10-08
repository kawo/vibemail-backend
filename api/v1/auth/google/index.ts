import { handlers } from '../../../../src/http';

/** GET /api/v1/auth/google — CONTRACT.md §4.1c (bearer): 302 to Google's consent screen. */
export const GET = handlers.redirectConnect;

/** Every other method → 405 METHOD_NOT_ALLOWED with the §3.3 envelope. */
export const POST = handlers.oauthMethodNotAllowed;
export const PUT = handlers.oauthMethodNotAllowed;
export const PATCH = handlers.oauthMethodNotAllowed;
export const DELETE = handlers.oauthMethodNotAllowed;
export const OPTIONS = handlers.oauthMethodNotAllowed;
