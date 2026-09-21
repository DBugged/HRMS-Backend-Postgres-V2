import {
  assertProductionConfig,
  cookieSecure,
  productionConfigProblems,
  swaggerEnabled,
} from './production-config';

const good = {
  NODE_ENV: 'production',
  CORS_ORIGIN: 'https://hr.example.com',
  FRONTEND_URL: 'https://hr.example.com',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  JWT_REFRESH_SECRET: 'b'.repeat(40),
} as NodeJS.ProcessEnv;

describe('production config', () => {
  it('is a no-op outside production', () => {
    expect(productionConfigProblems({ NODE_ENV: 'test' })).toEqual([]);
    expect(cookieSecure({ NODE_ENV: 'test' })).toBe(false);
    expect(swaggerEnabled({ NODE_ENV: 'test' })).toBe(true);
  });
  it('accepts a good config', () => {
    expect(productionConfigProblems(good)).toEqual([]);
  });
  it('rejects missing frontend URL and placeholder secrets (CORS origin is unrestricted)', () => {
    expect(productionConfigProblems({ NODE_ENV: 'production' }).length).toBe(3);
    expect(productionConfigProblems({ ...good, CORS_ORIGIN: '*' })).toEqual([]);
    expect(
      productionConfigProblems({
        ...good,
        FRONTEND_URL: 'http://localhost:5173',
      }).length,
    ).toBe(1);
    expect(() =>
      assertProductionConfig({ ...good, JWT_ACCESS_SECRET: 'replace_with_x' }),
    ).toThrow(/JWT_ACCESS_SECRET/);
  });
  it('warns when SMTP is missing', () => {
    const warn = jest.fn();
    assertProductionConfig(good, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SMTP'));
  });
  it('secure cookie defaults on in production with env override', () => {
    expect(cookieSecure(good)).toBe(true);
    expect(cookieSecure({ ...good, COOKIE_SECURE: 'false' })).toBe(false);
  });
  it('swagger needs ENABLE_SWAGGER in production', () => {
    expect(swaggerEnabled(good)).toBe(false);
    expect(swaggerEnabled({ ...good, ENABLE_SWAGGER: 'true' })).toBe(true);
  });
});

describe('production config warnings', () => {
  it('warns when BACKEND_PUBLIC_URL is unset, localhost or http', () => {
    const { productionConfigWarnings } = jest.requireActual<
      typeof import('./production-config')
    >('./production-config');
    expect(productionConfigWarnings(good)).toHaveLength(1);
    expect(
      productionConfigWarnings({
        ...good,
        BACKEND_PUBLIC_URL: 'http://localhost:4000',
      }),
    ).toHaveLength(1);
    expect(
      productionConfigWarnings({
        ...good,
        BACKEND_PUBLIC_URL: 'https://api.example.com',
      }),
    ).toEqual([]);
  });
});
