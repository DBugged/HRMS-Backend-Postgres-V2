// Purpose: Guards that the production docs gate applies to every Swagger URL (incl. the raw OpenAPI JSON/YAML).
import { SWAGGER_PATHS, swaggerAuthCheck } from './production-config';

const basic = (u: string, p: string) =>
  'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

describe('swagger docs gate', () => {
  const prod = {
    NODE_ENV: 'production',
    SWAGGER_USER: 'u',
    SWAGGER_PASSWORD: 'p',
  };

  it('covers the UI and the raw OpenAPI documents', () => {
    expect(SWAGGER_PATHS).toEqual(
      expect.arrayContaining(['/api/docs', '/api/docs-json', '/api/docs-yaml']),
    );
  });
  it('accepts only the correct credentials in production', () => {
    const check = swaggerAuthCheck(prod)!;
    expect(check(basic('u', 'p'))).toBe(true);
    expect(check(basic('u', 'x'))).toBe(false);
    expect(check(undefined)).toBe(false);
  });
  it('is off outside production or without credentials', () => {
    expect(swaggerAuthCheck({ ...prod, NODE_ENV: 'development' })).toBeNull();
    expect(swaggerAuthCheck({ NODE_ENV: 'production' })).toBeNull();
  });
});
