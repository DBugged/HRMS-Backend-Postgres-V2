import { Global, Module } from '@nestjs/common';
import { RedisThrottlerStorage } from './redis-throttler-storage';

// Global so ThrottlerModule.forRootAsync's inject: [RedisThrottlerStorage]
// can resolve it without a circular import back to this module.
@Global()
@Module({
  providers: [RedisThrottlerStorage],
  exports: [RedisThrottlerStorage],
})
export class RedisThrottlerStorageModule {}
