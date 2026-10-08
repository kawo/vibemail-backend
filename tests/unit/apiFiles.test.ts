/**
 * The `api/` files are one-line bindings. These tests check each exports exactly the contracted
 * methods, and that a request without configuration yields a 500 envelope rather than a crash.
 */
import * as start from '../../api/v1/auth/google/start';
import * as redirectStart from '../../api/v1/auth/google/index';
import * as callback from '../../api/v1/auth/google/callback';
import * as list from '../../api/v1/messages/index';
import * as send from '../../api/v1/messages/send';
import * as read from '../../api/v1/messages/[id]/read';
import * as webhook from '../../api/webhook/gmail';
import * as cron from '../../api/cron/renew-watch';

describe('api/ function files (CONTRACT.md §4)', () => {
  it.each([
    ['start', start, ['GET', 'OPTIONS']],
    ['redirect start', redirectStart, ['DELETE', 'GET', 'OPTIONS', 'PATCH', 'POST', 'PUT']],
    ['callback', callback, ['DELETE', 'GET', 'OPTIONS', 'PATCH', 'POST', 'PUT']],
    ['messages', list, ['GET', 'OPTIONS']],
    ['send', send, ['OPTIONS', 'POST']],
    ['read', read, ['OPTIONS', 'POST']],
    ['webhook', webhook, ['POST']],
    ['cron', cron, ['GET']],
  ])('%s exports only %j', (_name, module, methods) => {
    expect(Object.keys(module).sort()).toEqual(methods);
  });

  it('returns a 500 envelope when the environment is not configured', async () => {
    const saved = { ...process.env };
    for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_SECRET', 'ENCRYPTION_KEY']) {
      delete process.env[name];
    }
    try {
      const response = await list.GET(new Request('https://api.vibemail.test/api/v1/messages'));
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'INTERNAL', retryable: false } });
    } finally {
      process.env = saved;
    }
  });
});
