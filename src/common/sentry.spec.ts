import * as Sentry from '@sentry/nestjs';
import { captureException, initSentry } from './sentry';

jest.mock('@sentry/nestjs', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
}));

describe('sentry', () => {
  const original = process.env.SENTRY_DSN;

  afterEach(() => {
    if (original === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = original;
    jest.clearAllMocks();
  });

  describe('initSentry', () => {
    it('no-ops when SENTRY_DSN is unset', () => {
      delete process.env.SENTRY_DSN;
      initSentry();
      expect(Sentry.init).not.toHaveBeenCalled();
    });

    it('initializes Sentry when SENTRY_DSN is set', () => {
      process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0';
      initSentry();
      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({ dsn: process.env.SENTRY_DSN }),
      );
    });
  });

  describe('captureException', () => {
    it('no-ops when SENTRY_DSN is unset', () => {
      delete process.env.SENTRY_DSN;
      captureException(new Error('boom'));
      expect(Sentry.captureException).not.toHaveBeenCalled();
    });

    it('forwards to Sentry.captureException when SENTRY_DSN is set', () => {
      process.env.SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0';
      const err = new Error('boom');
      captureException(err);
      expect(Sentry.captureException).toHaveBeenCalledWith(err);
    });
  });
});
