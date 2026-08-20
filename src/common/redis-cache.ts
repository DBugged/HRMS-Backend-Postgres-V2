import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { getRedisUrl, redisEnabled } from './redis.config';

// Generic read-through cache for frequently-read, rarely-written rows —
// same opt-in-driver convention as everywhere else (unset REDIS_URL means
// every call falls straight through to `load()`, byte-identical to before
// this existed). Values are JSON-serialized; callers own their own key
// namespacing (a `prefix:` convention, e.g. "statconfig:") and are
// responsible for calling `invalidate`/`invalidatePrefix` after any write
// that could change what a cached key would resolve to — this class never
// second-guesses that with its own TTL-only staleness tolerance.
@Injectable()
export class RedisCacheService implements OnModuleDestroy {
  private readonly client = redisEnabled()
    ? new Redis(getRedisUrl(), { maxRetriesPerRequest: null })
    : null;
  private destroyed = false;

  get enabled(): boolean {
    return this.client !== null;
  }

  async getOrSet<T>(
    key: string,
    ttlSeconds: number,
    load: () => Promise<T>,
  ): Promise<T> {
    if (!this.client) return load();
    const cached = await this.client.get(key);
    if (cached !== null) return JSON.parse(cached) as T;
    const value = await load();
    // undefined can't round-trip through JSON — skip caching it rather
    // than caching the string "undefined" and breaking the next read.
    if (value !== undefined) {
      await this.client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    }
    return value;
  }

  async invalidate(key: string): Promise<void> {
    if (!this.client) return;
    await this.client.del(key);
  }

  // Bounded by design: callers only ever use this for a single org+module's
  // cached entries (a handful of distinct dates at most), never a
  // wildcard across the whole keyspace.
  async invalidatePrefix(prefix: string): Promise<void> {
    if (!this.client) return;
    const keys = await this.client.keys(`${prefix}*`);
    if (keys.length > 0) await this.client.del(...keys);
  }

  async onModuleDestroy() {
    // .quit() (graceful, waits for in-flight commands then closes) rather
    // than .disconnect() (immediate) — ioredis can leave an internal
    // reconnect/heartbeat timer alive after a bare disconnect(), which
    // silently kept the process (and every e2e spec's own app instance)
    // from exiting even though the socket itself was closed. Guarded
    // against a second call for the same reason as
    // RedisThrottlerStorage.onModuleDestroy.
    if (this.destroyed) return;
    this.destroyed = true;
    await this.client?.quit();
  }
}
