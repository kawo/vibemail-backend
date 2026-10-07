import type { OutgoingMessage } from '../provider';

/**
 * RFC 2822 message builder for Gmail `messages.send` (CONTRACT.md §4.3). Pure: no I/O.
 * Non-ASCII header text is RFC 2047-encoded; bodies are UTF-8, base64 content-transfer-encoded.
 */

const CRLF = '\r\n';
const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
/** Max raw bytes per RFC 2047 encoded word, keeping each word within 75 characters. */
const ENCODED_WORD_BYTES = 45;

/** RFC 2047 `=?UTF-8?B?...?=` encoding, split into words on character boundaries. */
export function encodeHeaderText(text: string): string {
  if (ASCII_PRINTABLE.test(text)) {
    return text;
  }
  const words: string[] = [];
  let chunk = '';
  for (const ch of text) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > ENCODED_WORD_BYTES) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) {
    words.push(chunk);
  }
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(`${CRLF} `);
}

/** Encodes the display name of `Name <addr>` when it is not ASCII; bare addresses pass through. */
export function encodeAddress(address: string): string {
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(address.trim());
  if (!match) {
    return address.trim();
  }
  const [, rawName = '', addr = ''] = match;
  const name = rawName.replace(/^"(.*)"$/, '$1');
  if (!name) {
    return `<${addr}>`;
  }
  return ASCII_PRINTABLE.test(name) ? `${rawName} <${addr}>` : `${encodeHeaderText(name)} <${addr}>`;
}

function base64Body(text: string): string {
  return (Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g) ?? ['']).join(CRLF);
}

/** Builds the RFC 2822 message. Callers validate addresses and reject CR/LF in headers first. */
export function buildRfc2822(message: OutgoingMessage, date: Date = new Date()): string {
  const headers = [
    `From: ${encodeAddress(message.from)}`,
    `To: ${message.to.map(encodeAddress).join(', ')}`,
    ...(message.cc && message.cc.length > 0 ? [`Cc: ${message.cc.map(encodeAddress).join(', ')}`] : []),
    ...(message.bcc && message.bcc.length > 0 ? [`Bcc: ${message.bcc.map(encodeAddress).join(', ')}`] : []),
    `Subject: ${encodeHeaderText(message.subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    ...(message.inReplyTo ? [`In-Reply-To: ${message.inReplyTo}`] : []),
    ...(message.references ? [`References: ${message.references}`] : []),
    'MIME-Version: 1.0',
  ];

  const text = message.text ?? (message.html === undefined ? '' : undefined);
  if (text !== undefined && message.html !== undefined) {
    const boundary = `vibemail-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      base64Body(message.html),
      `--${boundary}--`,
      '',
    ].join(CRLF);
  }
  const html = text === undefined ? (message.html ?? '') : undefined;
  return [
    ...headers,
    `Content-Type: ${html === undefined ? 'text/plain' : 'text/html'}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(html ?? text ?? ''),
    '',
  ].join(CRLF);
}

/** The `raw` field for `messages.send`: the whole message, base64url-encoded. */
export function toRaw(rfc2822: string): string {
  return Buffer.from(rfc2822, 'utf8').toString('base64url');
}
