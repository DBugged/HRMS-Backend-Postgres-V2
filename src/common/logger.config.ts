import pino from 'pino';
import type { Params } from 'nestjs-pino';
import { createLogShipperStream } from './log-shipper.stream';

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
// - Opt-in centralized log shipping: when LOG_SHIP_URL is set, every log
//   line still goes to stdout (nothing about local visibility changes) but
//   is also batched and POSTed to that URL via log-shipper.stream.ts, for
//   forwarding to Loki/Logtail/a custom collector/etc. Same opt-in-driver
//   convention as FILE_STORAGE_DRIVER=s3, SENTRY_DSN, REDIS_URL,
//   EMAIL_DRIVER=resend — unset means byte-identical current behavior.
// Shipping and the local pino-pretty transport are mutually exclusive:
// pretty-printing is a dev-only convenience, shipping is a prod concern,
// and pino-http only accepts one of `transport` or a custom stream.
export function loggerModuleOptions(): Params {
  const isTest = process.env.NODE_ENV === 'test';
  const isProd = process.env.NODE_ENV === 'production';
  const logShipUrl = process.env.LOG_SHIP_URL;

  const options = {
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
  };

  if (logShipUrl && !isTest) {
    return {
      pinoHttp: [
        options,
        pino.multistream([
          { stream: process.stdout },
          { stream: createLogShipperStream({ url: logShipUrl }) },
        ]),
      ],
    };
  }

  return {
    pinoHttp: {
      ...options,
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
