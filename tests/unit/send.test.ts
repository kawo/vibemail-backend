import { ProviderError } from '../../src/providers/provider';
import { isValidAddress, sendForUser, validateSendInput } from '../../src/send';
import { createFakeProviderFactory } from '../fakes/fakeProvider';
import { MemoryMessages, MemoryUsers } from '../fakes/memoryRepos';

const USER = 'user-1';
const at = new Date('2026-10-06T10:00:00.000Z');

function setup(connected = true) {
  const { factory, box } = createFakeProviderFactory();
  const users = new MemoryUsers();
  if (connected) {
    users.rows.set(USER, {
      googleId: 'g',
      userId: USER,
      email: 'me@example.com',
      scopes: [],
      credentials: { refreshToken: 'r', accessToken: null, accessTokenExpiresAt: null },
      historyId: '1',
      lastSyncedAt: null,
    });
  }
  const messages = new MemoryMessages();
  const log = jest.fn();
  return { deps: { factory, users, messages, now: () => at, log }, box, users, messages, log };
}

describe('sendForUser (CONTRACT.md §4.3)', () => {
  it('sends from the account email, then stores the fetched sent message', async () => {
    const { deps, box, messages } = setup();
    const row = await sendForUser(deps, USER, { to: 'you@example.com', subject: 'Hi', body: 'Hello' });

    expect(box.sent).toEqual([{ from: 'me@example.com', to: ['you@example.com'], subject: 'Hi', text: 'Hello' }]);
    expect(box.calls.map((c) => c.method)).toEqual(['sendMessage', 'getMessage']);
    expect(row).toMatchObject({
      user_id: USER,
      gmail_id: 'sent-1',
      label_ids: ['SENT'],
      from_address: 'me@example.com',
      to_address: ['you@example.com'],
      subject: 'Hi',
      body_plain: 'Hello',
    });
    expect(messages.forUser(USER)).toEqual([row]);
  });

  it('passes threadId through unchanged, with no derived reply headers', async () => {
    const { deps, box } = setup();
    const row = await sendForUser(deps, USER, { to: ['a@x.io', 'B <b@x.io>'], subject: 'Topic', body: 'x', threadId: 'T123' });
    expect(box.sent[0]).toEqual({ from: 'me@example.com', to: ['a@x.io', 'B <b@x.io>'], subject: 'Topic', text: 'x', threadId: 'T123' });
    expect(row.thread_id).toBe('T123');
  });

  it('maps a Gmail 404 on threadId to MESSAGE_NOT_FOUND', async () => {
    const { deps, box } = setup();
    box.failNext.set('sendMessage', new ProviderError('not_found', 'thread'));
    await expect(sendForUser(deps, USER, { to: 'a@x.io', subject: 's', body: 'b', threadId: 'Tx' })).rejects.toMatchObject({
      code: 'MESSAGE_NOT_FOUND',
      details: { threadId: 'Tx' },
    });
  });

  it('reports sentGmailId when fetching the sent message fails', async () => {
    const { deps, box, log } = setup();
    box.failNext.set('getMessage', new ProviderError('upstream', 'boom'));
    await expect(sendForUser(deps, USER, { to: 'a@x.io', subject: 's', body: 'b' })).rejects.toMatchObject({
      code: 'GMAIL_UPSTREAM_ERROR',
      details: { sentGmailId: 'sent-1' },
    });
    expect(log).toHaveBeenCalled();
  });

  it('reports sentGmailId as INTERNAL when storing fails', async () => {
    const { deps, messages } = setup();
    jest.spyOn(messages, 'upsertMessages').mockRejectedValue(new Error('db down'));
    await expect(sendForUser(deps, USER, { to: 'a@x.io', subject: 's', body: 'b' })).rejects.toMatchObject({
      code: 'INTERNAL',
      details: { sentGmailId: 'sent-1' },
    });
  });

  it('clears tokens and reports GMAIL_TOKEN_REVOKED on invalid_grant', async () => {
    const { deps, box, users } = setup();
    box.failNext.set('sendMessage', new ProviderError('revoked', 'invalid_grant'));
    await expect(sendForUser(deps, USER, { to: 'a@x.io', subject: 's', body: 'b' })).rejects.toMatchObject({
      code: 'GMAIL_TOKEN_REVOKED',
    });
    expect(users.cleared).toEqual([USER]);
  });

  it('rejects an unconnected user and invalid input without any provider call', async () => {
    const unconnected = setup(false);
    await expect(sendForUser(unconnected.deps, USER, { to: 'a@x.io', subject: 's', body: 'b' })).rejects.toMatchObject({
      code: 'GMAIL_NOT_CONNECTED',
    });
    const invalid = setup();
    await expect(sendForUser(invalid.deps, USER, { to: [], subject: 's', body: 'b' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect([...unconnected.box.calls, ...invalid.box.calls]).toEqual([]);
  });
});

describe('validateSendInput', () => {
  it('collects every issue', () => {
    expect(() =>
      validateSendInput({ to: ['nope', 'ok@x.io'], subject: 'a\r\nBcc: evil@x.io', body: 3, threadId: '../x' }),
    ).toThrow(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
        details: {
          issues: [
            { field: 'to[0]', message: 'not a valid email address' },
            { field: 'subject', message: 'must not contain line breaks' },
            { field: 'body', message: 'must be a string' },
            { field: 'threadId', message: 'must be a Gmail thread ID' },
          ],
        },
      }),
    );
  });

  it('accepts a single address string, an empty body and an empty subject', () => {
    expect(validateSendInput({ to: ' a@x.io ', subject: '', body: '' })).toEqual({ to: ['a@x.io'], subject: '', body: '' });
  });

  it('caps recipients at 100 and subjects at 998 characters', () => {
    const many = Array.from({ length: 101 }, (_, i) => `u${i}@x.io`);
    expect(() => validateSendInput({ to: many, subject: 's', body: 'b' })).toThrow(/invalid send request/);
    expect(() => validateSendInput({ to: 'a@x.io', subject: 's'.repeat(999), body: 'b' })).toThrow(/invalid send request/);
  });

  it.each([
    ['a@x.io', true],
    ['"Doe, Jane" <jane@x.io>', true],
    ['Bob <b@x.io>', true],
    ['no-at-sign', false],
    ['a@x.io\r\nBcc: e@x.io', false],
    ['Bob <not an address>', false],
  ])('isValidAddress(%j) is %s', (address, valid) => {
    expect(isValidAddress(address)).toBe(valid);
  });
});
