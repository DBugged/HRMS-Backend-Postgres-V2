import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import Redis from 'ioredis';
import { getRedisUrl, redisEnabled } from './redis.config';

// Not part of @nestjs/throttler's public export barrel (only the
// ThrottlerStorage interface is), so declared locally matching its shape.
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

// @nestjs/throttler's default ThrottlerStorageService keeps hit counts in a
// process-local Map, so per-IP/per-route limits (AUTH_THROTTLE_LIMIT,
// EXPENSIVE_OP_THROTTLE_LIMIT, the global default) are enforced per
// instance, not cluster-wide — behind a load balancer with N instances, an
// attacker's effective quota is multiplied by N. This mirrors the same
// increment/block algorithm against Redis instead, atomically via a Lua
// script (avoids a check-then-set race between concurrent requests hitting
// different instances at once), so every instance shares one counter.
// Only constructed when REDIS_URL is set — see app.module.ts.
const INCREMENT_SCRIPT = `
local hitsKey = KEYS[1]
local blockedKey = KEYS[2]
local ttlMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockMs = tonumber(ARGV[3])

local blockedPttl = redis.call('PTTL', blockedKey)
if blockedPttl > 0 then
  local hitsPttl = redis.call('PTTL', hitsKey)
  if hitsPttl < 0 then hitsPttl = 0 end
  return {0, hitsPttl, 1, blockedPttl}
end

local hits = redis.call('INCR', hitsKey)
if hits == 1 then
  redis.call('PEXPIRE', hitsKey, ttlMs)
end
local hitsPttl = redis.call('PTTL', hitsKey)
if hitsPttl < 0 then hitsPttl = 0 end

local isBlocked = 0
local blockPttl = 0
if hits > limit then
  redis.call('SET', blockedKey, '1', 'PX', blockMs)
  isBlocked = 1
  blockPttl = blockMs
end

return {hits, hitsPttl, isBlocked, blockPttl}
`;

// Always a real Nest provider (constructed via DI, never `new`'d directly)
// so onModuleDestroy actually runs and closes the connection on app
// shutdown — a manually-constructed instance passed into
// ThrottlerModule.forRoot()'s options is invisible to Nest's lifecycle,
// which silently leaked one open Redis socket per app instance (harmless
// in a long-running single process, but piled up across every e2e spec's
// own app instance and left Jest unable to exit).
@Injectable()
export class RedisThrottlerStorage
  implements ThrottlerStorage, OnModuleDestroy
{
  private readonly client = redisEnabled()
    ? new Redis(getRedisUrl(), { maxRetriesPerRequest: null })
    : null;
  private destroyed = false;

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    if (!this.client) {
      throw new Error(
        'RedisThrottlerStorage.increment() called while Redis is disabled — this storage should never be wired into ThrottlerModule when REDIS_URL is unset.',
      );
    }
    const prefix = `throttler:${throttlerName}:${key}`;
    const [totalHits, timeToExpireMs, isBlockedRaw, timeToBlockExpireMs] =
      (await this.client.eval(
        INCREMENT_SCRIPT,
        2,
        `${prefix}:hits`,
        `${prefix}:blocked`,
        ttl,
        limit,
        blockDuration || ttl,
      )) as [number, number, number, number];

    return {
      totalHits,
      timeToExpire: Math.ceil(timeToExpireMs / 1000),
      isBlocked: isBlockedRaw === 1,
      timeToBlockExpire: Math.ceil(timeToBlockExpireMs / 1000),
    };
  }

  async onModuleDestroy() {
    // See RedisCacheService.onModuleDestroy — .quit() over .disconnect()
    // for the same reason (a bare disconnect() left the process unable to
    // exit). Guarded: Nest calls onModuleDestroy on this singleton once
    // per module context that references it (this provider is resolved
    // both directly and via ThrottlerModule.forRootAsync's inject), so a
    // second call must be a no-op rather than throwing on an
    // already-closed connection.
    if (this.destroyed) return;
    this.destroyed = true;
    await this.client?.quit();
  }
}
