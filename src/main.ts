import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(
    helmet({
      // Swagger UI (served from this same app at /api/docs) needs inline
      // scripts/styles — a strict default CSP would break it. Everything
      // else (HSTS, X-Frame-Options, X-Content-Type-Options, etc.) stays
      // at helmet's secure defaults.
      contentSecurityPolicy: false,
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

  app.enableCors({
    origin: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(','),
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
