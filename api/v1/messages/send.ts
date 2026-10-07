import { handlers } from '../../../src/http';

/** POST /api/v1/messages/send — CONTRACT.md §4.3 (bearer). */
export const POST = handlers.sendMessage;
export const OPTIONS = handlers.options;
