import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { initSentry } from './common/sentry';
import { assertPersonalDataKeyConfigured } from './common/personal-data-crypto';
import {
  assertProductionConfig,
  corsOrigins,
  swaggerEnabled,
} from './common/production-config';

// Called before NestFactory.create() so an error during module
// bootstrapping itself (a bad Prisma connection string, a provider that
// throws in its constructor, etc.) still has a chance of being captured —
// no-ops entirely unless SENTRY_DSN is set, see sentry.ts.
initSentry();

async function bootstrap() {
  // Fail fast in production when PERSONAL_DATA_ENCRYPTION_KEY is missing/invalid.
  assertPersonalDataKeyConfigured();
  // Fail fast on unsafe production config (CORS, JWT secrets, FRONTEND_URL).
  assertProductionConfig();
  // bufferLogs holds Nest's own startup logs (module init order, route
  // registration, etc.) until app.useLogger() below installs pino as the
  // sink, instead of emitting them through Nest's default plain-text
  // console logger first.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Unset (default): req.ip is the direct TCP peer address — correct as
  // long as this app is reached directly, and unchanged from today's
  // behavior. Once it sits behind a reverse proxy/load balancer, set
  // TRUST_PROXY to the number of proxy hops in front of it (e.g. "1" for a
  // single nginx/ALB/Cloudflare hop) so req.ip — which ThrottlerGuard keys
  // its per-IP rate limit on, and which auth.service.ts logs against login
  // attempts — reflects the real client rather than the proxy's own
  // address. Deliberately opt-in and numeric-hop-based rather than
  // Express's `true` (trust every hop): trusting an unbounded chain lets a
  // client forge X-Forwarded-For and either collapse every real client
  // into one throttle bucket or spoof past the per-IP limit entirely.
  const trustProxyHops = process.env.TRUST_PROXY;
  if (trustProxyHops) {
    const hops = Number(trustProxyHops);
    (app.getHttpAdapter().getInstance() as import('express').Express).set(
      'trust proxy',
      Number.isFinite(hops) ? hops : trustProxyHops,
    );
  }

  app.use(
    helmet({
      // Swagger UI (served from this same app at /api/docs) needs inline
      // scripts/styles — a strict default CSP would break it. Everything
      // else (HSTS, X-Frame-Options, X-Content-Type-Options, etc.) stays
      // at helmet's secure defaults.
      contentSecurityPolicy: false,
      // Helmet's default 'same-origin' CORP blocks the browser from
      // rendering anything this API serves (branding logos, uploaded
      // documents, profile photos — all under /files) whenever the
      // frontend is on a different origin, which is the normal case (a
      // different port in dev, a different subdomain in prod). Access to
      // those resources is already controlled by the signed token in the
      // URL and by CORS above, so CORP here was only breaking legitimate
      // same-app cross-origin image loads, not adding real protection.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(cookieParser());

  // whitelist/forbidNonWhitelisted: DTOs are the single source of truth for
  // both validation and Swagger schema (see class-validator + @ApiProperty
  // on the same class) — a request field not declared on the DTO is
  // rejected rather than silently ignored.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Only allowlisted origins (CORS_ORIGIN, else FRONTEND_URL) may make
  // credentialed cross-origin requests.
  app.enableCors({
    origin: corsOrigins(),
    credentials: true, // required for the httpOnly refresh cookie to be sent/received cross-origin
  });

  if (swaggerEnabled()) {
    // Optional basic-auth gate for the docs when SWAGGER_USER/PASSWORD are set.
    const { SWAGGER_USER, SWAGGER_PASSWORD } = process.env;
    if (
      process.env.NODE_ENV === 'production' &&
      SWAGGER_USER &&
      SWAGGER_PASSWORD
    ) {
      const expected =
        'Basic ' +
        Buffer.from(`${SWAGGER_USER}:${SWAGGER_PASSWORD}`).toString('base64');
      app.use(
        '/api/docs',
        (req: Request, res: Response, next: NextFunction) => {
          const got = Buffer.from(req.headers.authorization ?? '');
          const want = Buffer.from(expected);
          if (got.length === want.length && timingSafeEqual(got, want))
            return next();
          res.setHeader('WWW-Authenticate', 'Basic realm="docs"');
          res.status(401).send('Authentication required');
        },
      );
    }
    const swaggerConfig = new DocumentBuilder()
      .setTitle('HRMS Backend v2')
      .setDescription(
        'Auth + RBAC foundation (Phase 1 of the NestJS/Prisma/Postgres migration)',
      )
      .setVersion('0.1.0')
      .addBearerAuth(
        { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        'access-token',
      )
      .addCookieAuth('refresh_token')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
