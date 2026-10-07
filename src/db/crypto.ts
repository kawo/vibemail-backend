import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { requireEnv } from '../config/env';

/**
 * AES-256-GCM token encryption (CONTRACT.md §5.4). Only `src/db/` may call this.
 * Stored form: `v1:<iv b64>:<authTag b64>:<ciphertext b64>`.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/** A stored value that cannot be decrypted: wrong key, tampering, or bad format. Treated as revoked. */
export class TokenDecryptionError extends Error {
  constructor(reason: string) {
    super(`stored token cannot be decrypted: ${reason}`);
    this.name = 'TokenDecryptionError';
  }
}

export function parseEncryptionKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return key;
}

export function keyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  return parseEncryptionKey(requireEnv('ENCRYPTION_KEY', env));
}

export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptToken(stored: string, key: Buffer): string {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TokenDecryptionError('unrecognized format');
  }
  const [, ivB64, tagB64, ciphertextB64] = parts as [string, string, string, string];
  const iv = Buffer.from(ivB64, 'base64');
  if (iv.length !== IV_BYTES) {
    throw new TokenDecryptionError('bad IV length');
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new TokenDecryptionError('authentication failed');
  }
}
