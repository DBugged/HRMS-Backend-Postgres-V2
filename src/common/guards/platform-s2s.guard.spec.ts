import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ipAllowed,
  PlatformS2sGuard,
  platformCredentialMatches,
} from './platform-s2s.guard';

const ctx = (authorization: string | undefined, ip = '10.0.0.5') =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization }, ip }),
    }),
  }) as never;

const OLD = { ...process.env };
afterEach(() => {
  process.env = { ...OLD };
});

describe('platform S2S guard', () => {
  const guard = new PlatformS2sGuard();

  it('fails closed when no secret is configured', () => {
    delete process.env.PLATFORM_S2S_TOKEN;
    expect(() => guard.canActivate(ctx('Bearer x'))).toThrow(
      ServiceUnavailableException,
    );
  });

  it('accepts the configured token and refuses a wrong or missing one', () => {
    process.env.PLATFORM_S2S_TOKEN = 'a-long-enough-platform-secret-value-123';
    expect(
      guard.canActivate(ctx('Bearer a-long-enough-platform-secret-value-123')),
    ).toBe(true);
    expect(() => guard.canActivate(ctx('Bearer nope'))).toThrow(
      UnauthorizedException,
    );
    expect(() => guard.canActivate(ctx(undefined))).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts the previous token while a rotation is under way', () => {
    process.env.PLATFORM_S2S_TOKEN = 'new-secret-new-secret-new-secret-new-1';
    process.env.PLATFORM_S2S_TOKEN_PREVIOUS =
      'old-secret-old-secret-old-secret-old-1';
    expect(
      guard.canActivate(ctx('Bearer old-secret-old-secret-old-secret-old-1')),
    ).toBe(true);
  });

  it('refuses a caller outside the IP allowlist even with the right token', () => {
    process.env.PLATFORM_S2S_TOKEN = 'a-long-enough-platform-secret-value-123';
    process.env.PLATFORM_S2S_ALLOWED_IPS = '203.0.113.7';
    expect(() =>
      guard.canActivate(
        ctx('Bearer a-long-enough-platform-secret-value-123', '10.0.0.5'),
      ),
    ).toThrow(ForbiddenException);
    expect(
      guard.canActivate(
        ctx(
          'Bearer a-long-enough-platform-secret-value-123',
          '::ffff:203.0.113.7',
        ),
      ),
    ).toBe(true);
  });

  it('helpers behave on their own', () => {
    expect(platformCredentialMatches('', ['x'])).toBe(false);
    expect(platformCredentialMatches('x', [undefined, 'x'])).toBe(true);
    expect(ipAllowed('1.2.3.4', '')).toBe(true);
    expect(ipAllowed('1.2.3.4', '5.6.7.8')).toBe(false);
  });
});
