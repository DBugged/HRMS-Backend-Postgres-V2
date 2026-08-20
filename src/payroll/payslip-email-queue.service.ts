import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { redisEnabled, getRedisUrl } from '../common/redis.config';

export const PAYSLIP_EMAIL_QUEUE_NAME = 'payslip-email';

export interface PayslipEmailJobData {
  runId: string;
  organizationId: string;
}

// Producer half of the payslip-email background job. Deliberately plain
// BullMQ classes (Queue/Worker) rather than @nestjs/bullmq's
// BullModule.registerQueue() — that needs a root connection registered
// somewhere in the module tree even when unused, which would mean either
// attempting a Redis connection unconditionally (defeating the opt-in
// design) or threading a conditional-import ternary through app.module.ts
// for a single job type. A plain injectable service that only constructs
// a real Queue when REDIS_URL is set is simpler and has the same
// zero-footprint-when-disabled guarantee as every other opt-in driver in
// this codebase (FILE_STORAGE_DRIVER=s3, SENTRY_DSN).
@Injectable()
export class PayslipEmailQueueService implements OnModuleDestroy {
  private readonly queue: Queue<PayslipEmailJobData> | null;
  // Kept so onModuleDestroy can close it explicitly — BullMQ's
  // queue.close() only closes a connection it created internally itself;
  // an externally-supplied `connection` instance (as here) is the
  // caller's responsibility to close, and was previously never closed at
  // all, leaking one open Redis socket per app instance.
  private readonly connection: IORedis | null;

  constructor() {
    this.connection = redisEnabled()
      ? new IORedis(getRedisUrl(), { maxRetriesPerRequest: null })
      : null;
    this.queue = this.connection
      ? new Queue<PayslipEmailJobData>(PAYSLIP_EMAIL_QUEUE_NAME, {
          connection: this.connection,
        })
      : null;
  }

  get enabled(): boolean {
    return this.queue !== null;
  }

  // Returns true if the job was actually queued. Callers (PayrollService)
  // fall back to doing the work inline when this returns false — see
  // PayrollService.afterPay for the fallback branch.
  async enqueue(data: PayslipEmailJobData): Promise<boolean> {
    if (!this.queue) return false;
    await this.queue.add('send-payslip-email', data, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    return true;
  }

  async onModuleDestroy() {
    await this.queue?.close();
    await this.connection?.quit();
  }
}
