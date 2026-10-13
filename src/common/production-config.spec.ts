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
  it('rejects missing CORS origin, frontend URL and placeholder secrets', () => {
    expect(productionConfigProblems({ NODE_ENV: 'production' }).length).toBe(4);
    expect(
      productionConfigProblems({ ...good, CORS_ORIGIN: '' }).join('\n'),
    ).toMatch(/CORS_ORIGIN/);
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
    // ...and credentials: enabling it alone does not open the docs to everyone.
    expect(swaggerEnabled({ ...good, ENABLE_SWAGGER: 'true' })).toBe(false);
    expect(
      swaggerEnabled({
        ...good,
        ENABLE_SWAGGER: 'true',
        SWAGGER_USER: 'docs',
        SWAGGER_PASSWORD: 'a-strong-password',
      }),
    ).toBe(true);
  });
  it('warns about a missing or shared file-token secret and a weak platform token', () => {
    const warn = jest.fn();
    assertProductionConfig({ ...good, PLATFORM_S2S_TOKEN: 'short' }, warn);
    const text = warn.mock.calls.map((c) => c[0]).join('\n');
    expect(text).toMatch(/FILE_TOKEN_SECRET is unset/);
    expect(text).toMatch(/PLATFORM_S2S_TOKEN is weak/);
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
