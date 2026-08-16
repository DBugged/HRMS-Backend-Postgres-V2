// Same opt-in pattern as FILE_STORAGE_DRIVER=s3 / SENTRY_DSN: unset by
// default, so dev/test never attempts a Redis connection at all (no
// connection-retry error spam, no behavior change). Set REDIS_URL to a
// real `redis://` (or `rediss://`) URL to enable BullMQ-backed background
// jobs — currently just payslip email delivery on payroll pay().
export function redisEnabled(): boolean {
  return !!process.env.REDIS_URL;
}

export function getRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL must be set when queue features are enabled.');
  }
  return url;
}
