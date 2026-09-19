import { redactUrl } from './logger.config';

describe('redactUrl', () => {
  it('hides the signed file token in /files/:token', () => {
    expect(redactUrl('/files/abc.def')).toBe('/files/[REDACTED]');
    expect(redactUrl('/files/abc.def?x=1')).toBe('/files/[REDACTED]?x=1');
  });
  it('hides token-like query values', () => {
    expect(redactUrl('/auth/x?token=SECRET&a=1')).toBe(
      '/auth/x?token=[REDACTED]&a=1',
    );
  });
  it('leaves ordinary urls alone', () => {
    expect(redactUrl('/employees?page=1')).toBe('/employees?page=1');
  });
});
