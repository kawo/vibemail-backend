/**
 * Message normalisation (CONTRACT.md §5.1): Gmail format=full → ProviderMessage → messages row.
 * Covers base64url decoding, header extraction by name, from_address / to_address mapping, and
 * the booleans derived from labelIds.
 */
import type { gmail_v1 } from 'googleapis';
import { decodeBase64Url, parseGmailMessage } from '../../src/providers/gmail/messages';
import { toMessageRow } from '../../src/sync';

const syncedAt = new Date('2026-10-06T10:00:00.000Z');

function gmail(overrides: Partial<gmail_v1.Schema$Message>, payload: gmail_v1.Schema$MessagePart): gmail_v1.Schema$Message {
  return { id: 'm1', threadId: 't1', historyId: '42', internalDate: '1759744800000', labelIds: [], ...overrides, payload };
}

const row = (message: gmail_v1.Schema$Message) => toMessageRow('user-1', parseGmailMessage(message), syncedAt);

describe('base64url decoding', () => {
  it('decodes the URL-safe alphabet (- and _) without padding', () => {
    // '??>' is 'Pz8-' and '???' is 'Pz8_' in base64url ('Pz8+' / 'Pz8/' in standard base64).
    expect(decodeBase64Url('Pz8-')).toBe('??>');
    expect(decodeBase64Url('Pz8_')).toBe('???');
    expect(decodeBase64Url(Buffer.from('héllo wörld ✓', 'utf8').toString('base64url'))).toBe('héllo wörld ✓');
  });

  it('decodes body_plain and body_html from parts by mimeType', () => {
    const r = row(
      gmail({}, {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/html', filename: '', body: { data: Buffer.from('<p>Hi</p>').toString('base64url') } },
          { mimeType: 'text/plain', filename: '', body: { data: Buffer.from('Hi').toString('base64url') } },
        ],
      }),
    );
    expect(r).toMatchObject({ body_plain: 'Hi', body_html: '<p>Hi</p>' });
  });

  it('falls back to payload.body.data for a single-part message', () => {
    const r = row(gmail({}, { mimeType: 'text/plain', body: { data: Buffer.from('only part').toString('base64url') } }));
    expect(r).toMatchObject({ body_plain: 'only part', body_html: null });
  });
});

describe('header extraction by name', () => {
  it('is case-insensitive and takes the first occurrence', () => {
    const r = row(
      gmail({}, {
        mimeType: 'text/plain',
        headers: [
          { name: 'sUbJeCt', value: 'First subject' },
          { name: 'Subject', value: 'Second subject' },
          { name: 'DATE', value: 'Mon, 6 Oct 2026 10:00:00 +0000' },
          { name: 'message-id', value: '<id@x.io>' },
        ],
        body: {},
      }),
    );
    expect(r).toMatchObject({ subject: 'First subject', date_header: 'Mon, 6 Oct 2026 10:00:00 +0000', rfc822_message_id: '<id@x.io>' });
  });

  it('maps missing headers to the documented defaults', () => {
    expect(row(gmail({}, { mimeType: 'text/plain', body: {} }))).toMatchObject({
      subject: null,
      from_address: '',
      to_address: [],
      date_header: null,
    });
  });
});

describe('from_address and to_address mapping', () => {
  it('keeps From raw and splits To into an address array', () => {
    const r = row(
      gmail({}, {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: '"Doe, Jane" <jane@x.io>' },
          { name: 'To', value: 'a@x.io, "Smith, Bob" <bob@x.io>,  c@x.io ' },
        ],
        body: {},
      }),
    );
    expect(r.from_address).toBe('"Doe, Jane" <jane@x.io>');
    expect(r.to_address).toEqual(['a@x.io', '"Smith, Bob" <bob@x.io>', 'c@x.io']);
  });
});

describe('booleans derived from labelIds', () => {
  it.each([
    [['INBOX', 'UNREAD'], { is_read: false, is_starred: false }],
    [['INBOX'], { is_read: true, is_starred: false }],
    [['INBOX', 'STARRED'], { is_read: true, is_starred: true }],
    [['UNREAD', 'STARRED'], { is_read: false, is_starred: true }],
    [[], { is_read: true, is_starred: false }],
  ])('labelIds %j → %j', (labelIds, expected) => {
    expect(row(gmail({ labelIds }, { mimeType: 'text/plain', body: {} }))).toMatchObject({ ...expected, label_ids: labelIds });
  });
});
