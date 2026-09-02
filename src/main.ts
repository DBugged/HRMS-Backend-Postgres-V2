import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { initSentry } from './common/sentry';

// Called before NestFactory.create() so an error during module
// bootstrapping itself (a bad Prisma connection string, a provider that
// throws in its constructor, etc.) still has a chance of being captured —
// no-ops entirely unless SENTRY_DSN is set, see sentry.ts.
initSentry();

async function bootstrap() {
  // bufferLogs holds Nest's own startup logs (module init order, route
  // registration, etc.) until app.useLogger() below installs pino as the
  // sink, instead of emitting them through Nest's default plain-text
  // console logger first.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

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

  const allowedOrigins = (
    process.env.CORS_ORIGIN || 'http://localhost:5173'
  ).split(',');
  // Any localhost:* origin in dev — the frontend's dev server (and this
  // sandbox's preview tooling) doesn't always land on the same port
  // between sessions, and re-editing CORS_ORIGIN by hand every time a
  // preview picks a different port isn't sustainable. Production still
  // enforces the explicit allowedOrigins list only.
  const localhostAnyPort = /^http:\/\/localhost:\d+$/;
  app.enableCors({
    origin:
      process.env.NODE_ENV === 'production'
        ? allowedOrigins
        : (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin) || localhostAnyPort.test(origin)) {
              callback(null, true);
            } else {
              callback(new Error('Not allowed by CORS'));
            }
          },
    credentials: true, // required for the httpOnly refresh cookie to be sent/received cross-origin
  });

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

  await app.listen(process.env.PORT ?? 4000);
}
void bootstrap();
