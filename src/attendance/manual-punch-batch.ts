// Purpose: the small pure pieces behind "add a manual punch for many people and days at once".
// Responsibilities: runs the jobs a few at a time (so a big batch finishes quickly without hammering the database) and
//   turns any error into the sentence a person should read. One job failing never stops the others.
import { HttpException } from '@nestjs/common';

/** The most punches (people × days) one request may add. */
export const MAX_BULK_MANUAL_PUNCHES = 1000;

/** The sentence for an error: an HTTP error's own message, else a generic line (never a stack trace). */
export function punchErrorMessage(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    const message =
      typeof body === 'string'
        ? body
        : (body as { message?: string | string[] }).message;
    if (Array.isArray(message)) return message.join(', ');
    if (message) return message;
  }
  return 'The punch could not be recorded.';
}

/**
 * Runs `worker` over every item, at most `concurrency` at a time, and returns one result per item in the same order.
 * The worker's error becomes `{ ok: false, message }`; it is never thrown.
 */
export async function runInBatches<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency = 4,
): Promise<({ ok: true; value: R } | { ok: false; message: string })[]> {
  const results: ({ ok: true; value: R } | { ok: false; message: string })[] =
    new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await worker(items[i]) };
      } catch (err) {
        results[i] = { ok: false, message: punchErrorMessage(err) };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, lane),
  );
  return results;
}
