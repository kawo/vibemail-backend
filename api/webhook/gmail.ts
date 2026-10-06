import { handlers } from '../../src/http';

/**
 * POST /webhook/gmail (rewritten to /api/webhook/gmail) — CONTRACT.md §4.5.
 * Google-to-server Pub/Sub push, not a client endpoint: outside /api/v1, no bearer, no CORS.
 */
export const POST = handlers.gmailWebhook;
