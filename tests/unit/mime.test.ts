import { buildRfc2822, encodeAddress, encodeHeaderText, toRaw } from '../../src/providers/gmail/mime';

const date = new Date('2026-10-06T10:00:00.000Z');

function parse(mime: string) {
  const [head = '', ...rest] = mime.split('\r\n\r\n');
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r\n /g, ' ').split('\r\n')) {
    const i = line.indexOf(':');
    headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
  }
  return { headers, body: rest.join('\r\n\r\n') };
}

describe('buildRfc2822 (CONTRACT.md §4.3)', () => {
  it('builds a plain-text UTF-8 message with CRLF line endings', () => {
    const mime = buildRfc2822(
      { from: 'me@example.com', to: ['a@x.io', 'Bob <b@x.io>'], subject: 'Hello', text: 'Hi there ü' },
      date,
    );
    expect(mime).not.toMatch(/[^\r]\n/);
    const { headers, body } = parse(mime);
    expect(headers.get('from')).toBe('me@example.com');
    expect(headers.get('to')).toBe('a@x.io, Bob <b@x.io>');
    expect(headers.get('subject')).toBe('Hello');
    expect(headers.get('date')).toBe('Tue, 06 Oct 2026 10:00:00 +0000');
    expect(headers.get('mime-version')).toBe('1.0');
    expect(headers.get('content-type')).toBe('text/plain; charset=UTF-8');
    expect(headers.get('content-transfer-encoding')).toBe('base64');
    expect(headers.has('in-reply-to')).toBe(false);
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Hi there ü');
  });

  it('RFC 2047-encodes a non-ASCII subject and display name', () => {
    const mime = buildRfc2822({ from: 'me@example.com', to: ['Jürgen <j@x.io>'], subject: 'Grüße 👋', text: '' }, date);
    const { headers } = parse(mime);
    expect(headers.get('subject')).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(headers.get('to')).toMatch(/^=\?UTF-8\?B\?.+\?= <j@x\.io>$/);
  });

  it('splits long encoded subjects into words of at most 75 characters', () => {
    const encoded = encodeHeaderText('é'.repeat(100));
    const words = encoded.split('\r\n ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    const decoded = words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
    expect(decoded).toBe('é'.repeat(100));
  });

  it('wraps base64 body lines at 76 characters', () => {
    const { body } = parse(buildRfc2822({ from: 'a@x.io', to: ['b@x.io'], subject: 's', text: 'x'.repeat(500) }, date));
    for (const line of body.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('produces multipart/alternative when both text and html are given', () => {
    const mime = buildRfc2822({ from: 'a@x.io', to: ['b@x.io'], subject: 's', text: 't', html: '<b>h</b>' }, date);
    expect(parse(mime).headers.get('content-type')).toMatch(/^multipart\/alternative; boundary="/);
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8');
  });

  it('leaves ASCII names and bare addresses unchanged', () => {
    expect(encodeAddress(' plain@x.io ')).toBe('plain@x.io');
    expect(encodeAddress('"Doe, Jane" <jane@x.io>')).toBe('"Doe, Jane" <jane@x.io>');
  });

  it('base64url-encodes the raw message', () => {
    const raw = toRaw('Subject: ??>\r\n\r\nbody');
    expect(raw).not.toMatch(/[+/=]/);
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toBe('Subject: ??>\r\n\r\nbody');
  });
});
