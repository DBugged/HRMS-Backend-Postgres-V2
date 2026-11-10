import { domainOf } from './email-dns';

describe('domainOf', () => {
  it('reads the domain from a bare or named address', () => {
    expect(domainOf('hello@Example.IN')).toBe('example.in');
    expect(domainOf('"D\'Rect HR" <hr@drecthr.com>')).toBe('drecthr.com');
  });
  it('returns an empty string when there is no domain', () => {
    expect(domainOf('')).toBe('');
    expect(domainOf('nobody')).toBe('');
  });
});
