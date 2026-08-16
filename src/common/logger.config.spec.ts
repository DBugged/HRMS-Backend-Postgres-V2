import { loggerModuleOptions } from './logger.config';

describe('loggerModuleOptions', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns a plain pinoHttp options object when LOG_SHIP_URL is unset', () => {
    delete process.env.LOG_SHIP_URL;
    process.env.NODE_ENV = 'development';
    const { pinoHttp } = loggerModuleOptions();
    expect(Array.isArray(pinoHttp)).toBe(false);
  });

  it('returns a [options, multistream] tuple when LOG_SHIP_URL is set outside test', () => {
    process.env.LOG_SHIP_URL = 'https://logs.example.com/ingest';
    process.env.NODE_ENV = 'production';
    const { pinoHttp } = loggerModuleOptions();
    expect(Array.isArray(pinoHttp)).toBe(true);
    if (Array.isArray(pinoHttp)) {
      const [options, stream] = pinoHttp;
      expect(options).toMatchObject({ autoLogging: true });
      expect(stream).toBeDefined();
    }
  });

  it('ignores LOG_SHIP_URL during the test env (stays silent, no shipping)', () => {
    process.env.LOG_SHIP_URL = 'https://logs.example.com/ingest';
    process.env.NODE_ENV = 'test';
    const { pinoHttp } = loggerModuleOptions();
    expect(Array.isArray(pinoHttp)).toBe(false);
    if (!Array.isArray(pinoHttp) && !('pipe' in (pinoHttp as object))) {
      expect((pinoHttp as { level?: string }).level).toBe('silent');
    }
  });
});
