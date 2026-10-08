import { handlers } from '../../../../src/http';

/** GET /api/v1/auth/google — CONTRACT.md §4.1a (no auth): 302 to Google sign-in, state cookie set. */
export const GET = handlers.startSignIn;

/** Every other method → 405 METHOD_NOT_ALLOWED with the §3.3 envelope. */
export const POST = handlers.oauthMethodNotAllowed;
export const PUT = handlers.oauthMethodNotAllowed;
export const PATCH = handlers.oauthMethodNotAllowed;
export const DELETE = handlers.oauthMethodNotAllowed;
export const OPTIONS = handlers.oauthMethodNotAllowed;
