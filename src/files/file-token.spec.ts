import { signFileToken, verifyFileToken } from './file-token';

describe('signFileToken / verifyFileToken', () => {
  const ORIGINAL_ENV = process.env.FILE_TOKEN_SECRET;

  beforeAll(() => {
    process.env.FILE_TOKEN_SECRET = 'test-secret-for-file-tokens';
  });

  afterAll(() => {
    process.env.FILE_TOKEN_SECRET = ORIGINAL_ENV;
  });

  it('round-trips organizationId and relativeKey', () => {
    const token = signFileToken('org-1', 'org-1/documents/abc.pdf');
    const claim = verifyFileToken(token);
    expect(claim).toEqual({
      organizationId: 'org-1',
      relativeKey: 'org-1/documents/abc.pdf',
    });
  });

  it('rejects a tampered payload', () => {
    const token = signFileToken('org-1', 'org-1/documents/abc.pdf');
    const [json, sig] = token.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        o: 'org-2',
        p: 'org-1/documents/abc.pdf',
        e: Date.now() + 60000,
      }),
    ).toString('base64url');
    const tampered = `${tamperedPayload}.${sig}`;
    void json;
    expect(verifyFileToken(tampered)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = signFileToken('org-1', 'org-1/documents/abc.pdf');
    process.env.FILE_TOKEN_SECRET = 'a-different-secret';
    expect(verifyFileToken(token)).toBeNull();
    process.env.FILE_TOKEN_SECRET = 'test-secret-for-file-tokens';
  });

  it('rejects an expired token', () => {
    const token = signFileToken('org-1', 'org-1/documents/abc.pdf', -1);
    expect(verifyFileToken(token)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifyFileToken('not-a-real-token')).toBeNull();
    expect(verifyFileToken('')).toBeNull();
  });

  it('honors a custom TTL', () => {
    const token = signFileToken('org-1', 'org-1/documents/abc.pdf', 3600);
    expect(verifyFileToken(token)).not.toBeNull();
  });
});
