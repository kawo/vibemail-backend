import { handlers } from '../../../../src/http';

/** GET /api/v1/auth/google/start — CONTRACT.md §4.1a (bearer). */
export const GET = handlers.startConnect;
export const OPTIONS = handlers.options;
