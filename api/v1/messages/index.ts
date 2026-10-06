import { handlers } from '../../../src/http';

/** GET /api/v1/messages — CONTRACT.md §4.2 (bearer). */
export const GET = handlers.listMessages;
export const OPTIONS = handlers.options;
