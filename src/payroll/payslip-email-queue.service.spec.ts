// Mocked so `enabled: true` never attempts a real socket connection —
// this is a unit test of the enabled/disabled branching, not an
// integration test against a live Redis.
jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({})));
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { PayslipEmailQueueService } from './payslip-email-queue.service';

describe('PayslipEmailQueueService', () => {
  const original = process.env.REDIS_URL;

  afterEach(() => {
    if (original === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = original;
  });

  it('is disabled and never queues when REDIS_URL is unset', async () => {
    delete process.env.REDIS_URL;
    const service = new PayslipEmailQueueService();
    expect(service.enabled).toBe(false);
    const queued = await service.enqueue({
      runId: 'run-1',
      organizationId: 'org-1',
    });
    expect(queued).toBe(false);
    await service.onModuleDestroy();
  });

  it('constructs a queue and reports enabled when REDIS_URL is set', async () => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    const service = new PayslipEmailQueueService();
    expect(service.enabled).toBe(true);
    const queued = await service.enqueue({
      runId: 'run-1',
      organizationId: 'org-1',
    });
    expect(queued).toBe(true);
    await service.onModuleDestroy();
  });
});
