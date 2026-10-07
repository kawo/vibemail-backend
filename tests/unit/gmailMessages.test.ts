import type { gmail_v1 } from 'googleapis';
import { decodeBase64Url, header, parseGmailMessage, splitAddresses } from '../../src/providers/gmail/messages';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

/** A recorded-shape `format=full` message: multipart/mixed > multipart/alternative + one attachment. */
const nested: gmail_v1.Schema$Message = {
  id: '18c1',
  threadId: '18c0',
  labelIds: ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT'],
  snippet: 'Hello there',
  historyId: '18446744073709551000',
  internalDate: '1759700000000',
  sizeEstimate: 4321,
  payload: {
    partId: '',
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'subject', value: 'Quarterly report' },
      { name: 'FROM', value: '"Doe, Jane" <jane@example.com>' },
      { name: 'To', value: 'a@example.com, "Smith, Bob" <bob@example.com>' },
      { name: 'Cc', value: 'c@example.com' },
      { name: 'Message-ID', value: '<abc@mail.example.com>' },
      { name: 'In-Reply-To', value: '<prev@mail.example.com>' },
      { name: 'References', value: '<root@mail.example.com> <prev@mail.example.com>' },
      { name: 'date', value: 'Mon, 6 Oct 2026 09:00:00 +0200' },
      { name: 'Subject', value: 'second Subject header is ignored' },
    ],
    body: { size: 0 },
    parts: [
      {
        partId: '0',
        mimeType: 'multipart/alternative',
        body: { size: 0 },
        parts: [
          { partId: '0.0', mimeType: 'text/plain', filename: '', body: { size: 5, data: b64('Hi ü') } },
          { partId: '0.1', mimeType: 'text/html', filename: '', body: { size: 12, data: b64('<p>Hi ü</p>') } },
        ],
      },
      {
        partId: '1',
        mimeType: 'application/pdf',
        filename: 'report.pdf',
        body: { size: 2048, attachmentId: 'ATT1' },
      },
    ],
  },
};

describe('parseGmailMessage (CONTRACT.md §5.1)', () => {
  it('normalizes a nested multipart message', () => {
    expect(parseGmailMessage(nested)).toEqual({
      id: '18c1',
      threadId: '18c0',
      labels: ['INBOX', 'UNREAD', 'STARRED', 'IMPORTANT'],
      isRead: false,
      isStarred: true,
      inInbox: true,
      receivedAt: new Date(1759700000000),
      sizeBytes: 4321,
      snippet: 'Hello there',
      subject: 'Quarterly report',
      from: '"Doe, Jane" <jane@example.com>',
      to: ['a@example.com', '"Smith, Bob" <bob@example.com>'],
      cc: ['c@example.com'],
      bcc: [],
      rfc822MessageId: '<abc@mail.example.com>',
      inReplyTo: '<prev@mail.example.com>',
      references: '<root@mail.example.com> <prev@mail.example.com>',
      dateHeader: 'Mon, 6 Oct 2026 09:00:00 +0200',
      bodyText: 'Hi ü',
      bodyHtml: '<p>Hi ü</p>',
      attachments: [
        { partId: '1', filename: 'report.pdf', mimeType: 'application/pdf', size: 2048, attachmentId: 'ATT1' },
      ],
      syncCursor: '18446744073709551000',
    });
  });

  it('falls back to payload.body.data for a single-part message', () => {
    const plain = parseGmailMessage({
      ...nested,
      labelIds: ['INBOX'],
      payload: { mimeType: 'text/plain', headers: [], body: { size: 4, data: b64('only') } },
    });
    expect(plain).toMatchObject({ bodyText: 'only', bodyHtml: null, isRead: true, isStarred: false, attachments: [] });

    const html = parseGmailMessage({
      ...nested,
      payload: { mimeType: 'text/html', headers: [], body: { size: 9, data: b64('<b>x</b>') } },
    });
    expect(html).toMatchObject({ bodyText: null, bodyHtml: '<b>x</b>' });
  });

  it('defaults missing headers and labels', () => {
    const bare = parseGmailMessage({ id: 'x', threadId: 't', historyId: '1', internalDate: '0' });
    expect(bare).toMatchObject({
      labels: [],
      isRead: true,
      inInbox: false,
      subject: null,
      from: '',
      to: [],
      bodyText: null,
      bodyHtml: null,
    });
  });

  it('rejects a message without id, threadId, historyId or internalDate', () => {
    expect(() => parseGmailMessage({ id: 'x', threadId: 't', internalDate: '0' })).toThrow(/historyId/);
  });
});

describe('helpers', () => {
  it('matches header names case-insensitively, first occurrence wins', () => {
    expect(header(nested.payload ?? undefined, 'SUBJECT')).toBe('Quarterly report');
    expect(header(nested.payload ?? undefined, 'X-Missing')).toBeNull();
  });

  it('splits address lists outside quotes and angle brackets', () => {
    expect(splitAddresses('"Last, First" <a@x.io>, b@x.io , <c,d@x.io>')).toEqual([
      '"Last, First" <a@x.io>',
      'b@x.io',
      '<c,d@x.io>',
    ]);
    expect(splitAddresses(null)).toEqual([]);
  });

  it('decodes base64url', () => {
    expect(decodeBase64Url(b64('a+b/c?'))).toBe('a+b/c?');
    expect(decodeBase64Url(undefined)).toBeNull();
  });
});
