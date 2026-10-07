import { handlers } from '../../../../src/http';

/** POST /api/v1/messages/{id}/read — CONTRACT.md §4.4 (bearer). */
export const POST = handlers.markRead;
export const OPTIONS = handlers.options;
