// Purpose: Field-level AES-256-GCM encryption for sensitive identifiers inside User.personalData.
// Stored format per value: 'enc:v1:<iv b64>:<tag b64>:<ciphertext b64>'. Values without the prefix are legacy plaintext
// and pass through unchanged on read, so rows written before encryption was introduced keep working.
// Key: env PERSONAL_DATA_ENCRYPTION_KEY (32 bytes, base64 or 64-char hex). Production fails fast when missing; other
// environments fall back to a fixed dev key with a warning.
// Note: encrypted values can no longer be searched/sorted in SQL (no such queries exist today on these keys).
import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import { SENSITIVE_KEYS } from '../employees/personal-data-mask';

const PREFIX = 'enc:v1:';
const logger = new Logger('PersonalDataCrypto');

// Keys encrypted at rest: everything masked for managers (PAN, Aadhaar, UAN, bank account, IFSC, passport) plus ESIC.
export const ENCRYPTED_KEYS = new Set([
  ...SENSITIVE_KEYS,
  'esicnumber',
  'esicno',
  'esic',
]);

let cachedKey: Buffer | null = null;
let warned = false;

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error(
      'PERSONAL_DATA_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64).',
    );
  }
  return key;
}

export function getPersonalDataKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.PERSONAL_DATA_ENCRYPTION_KEY;
  if (raw) {
    cachedKey = parseKey(raw);
    return cachedKey;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'PERSONAL_DATA_ENCRYPTION_KEY is required in production (32-byte base64/hex).',
    );
  }
  if (!warned) {
    warned = true;
    logger.warn(
      'PERSONAL_DATA_ENCRYPTION_KEY is not set; using an insecure dev-only key. Never do this in production.',
    );
  }
  cachedKey = crypto.createHash('sha256').update('hrms-dev-only-key').digest();
  return cachedKey;
}

// Call at start-up so a production deploy without the key fails immediately rather than on the first write.
export function assertPersonalDataKeyConfigured(): void {
  getPersonalDataKey();
}

export function resetPersonalDataKeyCache(): void {
  cachedKey = null;
  warned = false;
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptValue(plain: string): string {
  if (isEncrypted(plain)) return plain; // idempotent
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getPersonalDataKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

// Legacy plaintext passes through; a tampered/wrong-key ciphertext throws.
export function decryptValue(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || ctB64 === undefined) {
    throw new Error('Malformed encrypted personal data value.');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getPersonalDataKey(),
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function mapSensitive(pd: unknown, fn: (v: string) => string): unknown {
  if (!pd || typeof pd !== 'object' || Array.isArray(pd)) return pd;
  const out: Record<string, unknown> = { ...(pd as Record<string, unknown>) };
  for (const [k, v] of Object.entries(out)) {
    if (ENCRYPTED_KEYS.has(k.toLowerCase()) && typeof v === 'string' && v) {
      out[k] = fn(v);
    }
  }
  return out;
}

export const encryptPersonalData = (pd: unknown) =>
  mapSensitive(pd, encryptValue);
export const decryptPersonalData = (pd: unknown) =>
  mapSensitive(pd, decryptValue);
