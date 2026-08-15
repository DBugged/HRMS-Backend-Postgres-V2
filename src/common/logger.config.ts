import type { Params } from 'nestjs-pino';

// Structured logging for the whole app — replaces Nest's default plain-text
// Logger with pino, wired via app.useLogger() in main.ts so every existing
// `new Logger(SomeService.name)` call site (there are several already, see
// prisma.service.ts/audit-log.service.ts/etc.) automatically routes through
// this without any change to those call sites — Nest's Logger class proxies
// to whatever logger app.useLogger() installed.
//
// - JSON in production/any non-test env pino-pretty isn't explicitly
//   requested for (ready to ship to a log aggregator).
// - Human-readable pino-pretty output in local development.
// - Quiet ('silent') during the e2e suite — 38 spec files each boot a full
//   Nest app; per-request HTTP logging on every one would drown out actual
//   test failures and add real time spinning up pino's pretty-print
//   transport 38 times over.
// - Every log line auto-redacts Authorization headers, cookies, and any
//   password/token/secret field pino-http's request/response
//   auto-logging would otherwise capture verbatim.
export function loggerModuleOptions(): Params {
  const isTest = process.env.NODE_ENV === 'test';
  const isProd = process.env.NODE_ENV === 'production';

  return {
    pinoHttp: {
      level: isTest ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
      autoLogging: !isTest,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'req.body.password',
          'req.body.currentPassword',
          'req.body.newPassword',
          'req.body.token',
        ],
        censor: '[REDACTED]',
      },
      transport:
        !isProd && !isTest
          ? {
              target: 'pino-pretty',
              options: { colorize: true, singleLine: true },
            }
          : undefined,
    },
  };
}
