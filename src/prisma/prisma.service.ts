import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// Prisma 7 requires an explicit driver adapter at runtime (the old
// url-in-schema config is CLI/migration-only now, see prisma.config.ts).
// PrismaService owns the connection lifecycle only; PrismaModule exports a
// second, *extended* client (see tenant-scope.extension.ts) that services
// actually inject for tenant-scoped models, since $extends() returns a new
// client instance rather than mutating this one in place.
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      // A pooled connection that the database or a firewall dropped while the server sat idle used to be handed to the
      // next request, which then hung until the OS gave up (a long spinner, then a cancelled save; the retry worked at
      // once on a fresh connection). Keep-alive probes find a dead peer early, idle connections are retired before
      // most firewalls drop them, and waiting for a connection fails after 10 s with a clear error instead of hanging.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    super({ adapter });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
