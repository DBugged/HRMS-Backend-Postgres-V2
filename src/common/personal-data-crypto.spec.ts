import {
  decryptPersonalData,
  decryptValue,
  encryptPersonalData,
  encryptValue,
  isEncrypted,
  resetPersonalDataKeyCache,
} from './personal-data-crypto';

describe('personal-data-crypto', () => {
  const original = process.env.PERSONAL_DATA_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.PERSONAL_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString(
      'base64',
    );
    resetPersonalDataKeyCache();
  });
  afterAll(() => {
    if (original === undefined) delete process.env.PERSONAL_DATA_ENCRYPTION_KEY;
    else process.env.PERSONAL_DATA_ENCRYPTION_KEY = original;
    resetPersonalDataKeyCache();
  });

  it('round-trips a value in the enc:v1 format with a random IV', () => {
    const a = encryptValue('ABCDE1234F');
    const b = encryptValue('ABCDE1234F');
    expect(a).toMatch(/^enc:v1:[^:]+:[^:]+:[^:]+$/);
    expect(a).not.toContain('ABCDE1234F');
    expect(a).not.toBe(b);
    expect(decryptValue(a)).toBe('ABCDE1234F');
  });

  it('passes legacy plaintext through and never double-encrypts', () => {
    expect(decryptValue('plain-legacy')).toBe('plain-legacy');
    const enc = encryptValue('x1');
    expect(encryptValue(enc)).toBe(enc);
  });

  it('throws on a tampered ciphertext or the wrong key', () => {
    const enc = encryptValue('123456789012');
    const parts = enc.split(':');
    parts[4] = Buffer.from('tampered!!!!').toString('base64');
    expect(() => decryptValue(parts.join(':'))).toThrow();
    process.env.PERSONAL_DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString(
      'hex',
    );
    resetPersonalDataKeyCache();
    // 32 bytes of 0x09 as base64/hex mismatch: hex string of 32 bytes is 64 chars -> valid key, different from before
    expect(() => decryptValue(enc)).toThrow();
  });

  it('accepts a 64-char hex key and rejects a wrong-length key', () => {
    process.env.PERSONAL_DATA_ENCRYPTION_KEY = 'ab'.repeat(32);
    resetPersonalDataKeyCache();
    expect(decryptValue(encryptValue('k'))).toBe('k');
    process.env.PERSONAL_DATA_ENCRYPTION_KEY = 'short';
    resetPersonalDataKeyCache();
    expect(() => encryptValue('k')).toThrow(/32 bytes/);
  });

  it('encrypts only sensitive string keys inside a personalData blob and decrypts them back', () => {
    const pd = {
      panNumber: 'ABCDE1234F',
      aadharNumber: '123412341234',
      bankAccountNo: '000111222333',
      bankIFSC: 'HDFC0001234',
      uanNumber: '100200300400',
      currentAddress: '12 Street',
      dateOfBirth: '1990-01-01',
      previousEmployment: [{ company: 'X' }],
      profileCompleted: true,
    };
    const enc = encryptPersonalData(pd) as Record<string, unknown>;
    expect(isEncrypted(enc.panNumber)).toBe(true);
    expect(isEncrypted(enc.bankIFSC)).toBe(true);
    expect(enc.currentAddress).toBe('12 Street');
    expect(enc.previousEmployment).toEqual(pd.previousEmployment);
    expect(decryptPersonalData(enc)).toEqual(pd);
  });

  it('falls back to a dev key outside production and throws in production when unset', () => {
    delete process.env.PERSONAL_DATA_ENCRYPTION_KEY;
    resetPersonalDataKeyCache();
    const env = process.env as Record<string, string | undefined>;
    const nodeEnv = env.NODE_ENV;
    env.NODE_ENV = 'test';
    expect(decryptValue(encryptValue('dev'))).toBe('dev');
    env.NODE_ENV = 'production';
    resetPersonalDataKeyCache();
    expect(() => encryptValue('dev')).toThrow(/required in production/);
    env.NODE_ENV = nodeEnv;
  });
});
