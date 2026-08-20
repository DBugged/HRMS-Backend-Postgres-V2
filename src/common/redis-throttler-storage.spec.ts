// Mocked so this never attempts a real socket connection — the Lua
// script's actual counting/blocking behavior was verified manually
// against a live Redis instance; this test covers the class's own
// marshaling (ms -> seconds, raw 0/1 -> boolean) which a mock can
// meaningfully verify without a live server.
const mockEval = jest.fn();
jest.mock('ioredis', () =>
  jest
    .fn()
    .mockImplementation(() => ({ eval: mockEval, disconnect: jest.fn() })),
);

import { RedisThrottlerStorage } from './redis-throttler-storage';

describe('RedisThrottlerStorage', () => {
  const original = process.env.REDIS_URL;

  beforeEach(() => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    mockEval.mockReset();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = original;
  });

  it('converts the Lua script tuple into a ThrottlerStorageRecord, not blocked', async () => {
    mockEval.mockResolvedValue([2, 1999, 0, 0]);
    const storage = new RedisThrottlerStorage();
    const record = await storage.increment(
      '1.2.3.4',
      60_000,
      100,
      60_000,
      'default',
    );
    expect(record).toEqual({
      totalHits: 2,
      timeToExpire: 2,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('converts a blocked tuple correctly', async () => {
    mockEval.mockResolvedValue([0, 1500, 1, 45_000]);
    const storage = new RedisThrottlerStorage();
    const record = await storage.increment(
      '1.2.3.4',
      60_000,
      100,
      60_000,
      'default',
    );
    expect(record.isBlocked).toBe(true);
    expect(record.timeToBlockExpire).toBe(45);
  });

  it('scopes the Redis keys by throttlerName and key so different limits never collide', async () => {
    mockEval.mockResolvedValue([1, 1000, 0, 0]);
    const storage = new RedisThrottlerStorage();
    await storage.increment('1.2.3.4', 60_000, 5, 60_000, 'auth');
    const [, , hitsKey, blockedKey] = mockEval.mock.calls[0] as unknown as [
      string,
      number,
      string,
      string,
    ];
    expect(hitsKey).toBe('throttler:auth:1.2.3.4:hits');
    expect(blockedKey).toBe('throttler:auth:1.2.3.4:blocked');
  });
});
