import { Global, Module } from '@nestjs/common';
import { RedisCacheService } from './redis-cache';

// Global, like PrismaModule — one shared Redis connection (when enabled)
// for every service that wants read-through caching, rather than each
// feature module opening its own.
@Global()
@Module({
  providers: [RedisCacheService],
  exports: [RedisCacheService],
})
export class RedisCacheModule {}
