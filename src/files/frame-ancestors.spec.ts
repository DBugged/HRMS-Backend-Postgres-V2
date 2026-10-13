import { frameAncestorsPolicy } from './frame-ancestors';

describe('frameAncestorsPolicy', () => {
  it('allows the app origins and itself', () => {
    expect(
      frameAncestorsPolicy({
        CORS_ORIGIN: 'https://hrms.example.com, https://app.example.com',
      }),
    ).toBe(
      "frame-ancestors 'self' https://hrms.example.com https://app.example.com",
    );
  });

  it('falls back to FRONTEND_URL and ignores entries that are not origins', () => {
    expect(
      frameAncestorsPolicy({ FRONTEND_URL: 'https://hrms.example.com' }),
    ).toBe("frame-ancestors 'self' https://hrms.example.com");
    expect(frameAncestorsPolicy({ CORS_ORIGIN: '*' })).toBe(
      "frame-ancestors 'self'",
    );
  });
});
