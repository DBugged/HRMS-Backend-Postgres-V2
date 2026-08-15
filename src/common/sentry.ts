import * as Sentry from '@sentry/nestjs';

// Opt-in, same pattern as FILE_STORAGE_DRIVER=s3 — no-op unless SENTRY_DSN
// is actually set, so dev/test/any deployment that hasn't configured a
// project never sends anything anywhere. Deliberately NOT using
// @sentry/nestjs's SentryModule/SentryGlobalFilter auto-instrumentation:
// that requires a separate instrument.ts preloaded before every other
// import (for HTTP/DB span tracing this app doesn't need) and its own
// global exception filter, which would have to be layered against
// AllExceptionsFilter's catch-all @Catch() carefully to avoid one
// silently swallowing what the other needs to see. Calling
// Sentry.captureException() directly from AllExceptionsFilter's existing
// "this is a genuine 5xx, not a routine 400/401/404" branch is the same
// error-capturing outcome with one obvious control point instead of two
// global filters racing.
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    tracesSampleRate: 0,
  });
}

export function captureException(exception: unknown): void {
  if (!process.env.SENTRY_DSN) return;
  Sentry.captureException(exception);
}
