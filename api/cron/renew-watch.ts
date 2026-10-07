import { handlers } from '../../src/http';

/** GET /api/cron/renew-watch — CONTRACT.md §4.6. Vercel Cron, daily at 06:00 UTC; CRON_SECRET bearer. */
export const GET = handlers.renewWatch;
