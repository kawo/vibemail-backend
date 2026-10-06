import { handlers } from '../../../../src/http';

/** GET /api/v1/auth/google/callback — CONTRACT.md §4.1b (Google redirect; signed state, no bearer). */
export const GET = handlers.oauthCallback;
