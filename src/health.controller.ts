// Purpose: the uptime check (GET /health) and the sink for errors the web app catches in the browser (POST /client-errors).
// Responsibilities: /health answers 200 only when the database answers, so a monitor sees a real outage, not just a running
//   process. /client-errors logs the report (and sends it to Sentry when SENTRY_DSN is set); it never touches the database.
// Important: both routes are @Public() (a monitor and a crashed page have no token) - the error route is throttled hard and
//   every field is length-capped so it cannot be used to flood the logs.
import { Body, Controller, Get, HttpCode, Logger, Post, ServiceUnavailableException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { Public } from './common/decorators/public.decorator';
import { PrismaService } from './prisma/prisma.service';
import { captureException } from './common/sentry';

class ClientErrorDto {
  @IsString() @MaxLength(500) message!: string;
  @IsOptional() @IsString() @MaxLength(4000) stack?: string;
  @IsOptional() @IsString() @MaxLength(500) url?: string;
  @IsOptional() @IsString() @MaxLength(50) app?: string;
}

@Controller()
export class HealthController {
  private readonly logger = new Logger('ClientError');

  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('health')
  async health() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'down', database: 'down' });
    }
    return { status: 'ok', database: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Public()
  @Post('client-errors')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  clientError(@Body() dto: ClientErrorDto) {
    this.logger.error(`[${dto.app ?? 'web'}] ${dto.message} @ ${dto.url ?? '-'}\n${dto.stack ?? ''}`);
    const err = new Error(dto.message);
    err.stack = dto.stack ?? err.stack;
    captureException(err);
  }
}
