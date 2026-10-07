import { randomBytes } from 'crypto';
import { TokenDecryptionError, decryptToken, encryptToken, parseEncryptionKey } from '../../src/db/crypto';

const key = randomBytes(32);

describe('token encryption (CONTRACT.md §5.4)', () => {
  it('round-trips and uses the v1 format', () => {
    const stored = encryptToken('ya29.secret', key);
    expect(stored).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(stored).not.toContain('ya29.secret');
    expect(decryptToken(stored, key)).toBe('ya29.secret');
  });

  it('uses a fresh IV per write', () => {
    expect(encryptToken('same', key)).not.toBe(encryptToken('same', key));
  });

  it('rejects a tampered ciphertext', () => {
    const [v, iv, tag, ct] = encryptToken('secret', key).split(':') as [string, string, string, string];
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() => decryptToken([v, iv, tag, flipped.toString('base64')].join(':'), key)).toThrow(
      TokenDecryptionError,
    );
  });

  it('rejects the wrong key and unknown formats', () => {
    const stored = encryptToken('secret', key);
    expect(() => decryptToken(stored, randomBytes(32))).toThrow(TokenDecryptionError);
    expect(() => decryptToken('plaintext-token', key)).toThrow(TokenDecryptionError);
    expect(() => decryptToken(stored.replace(/^v1/, 'v2'), key)).toThrow(TokenDecryptionError);
  });

  it('requires a 32-byte key', () => {
    expect(parseEncryptionKey(key.toString('base64'))).toHaveLength(32);
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
