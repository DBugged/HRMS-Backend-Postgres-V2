import { Writable } from 'stream';

export interface LogShipperOptions {
  url: string;
  batchSize?: number;
  flushIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

// Batches newline-delimited pino log lines and POSTs them to an external
// collector (Loki, Logtail, a custom webhook — anything that accepts
// x-ndjson) as a secondary multistream target alongside stdout. Shipping
// failures are swallowed: the log line already reached stdout via the
// other stream, so a network blip here must never crash the app or block
// request logging.
export function createLogShipperStream(options: LogShipperOptions): Writable {
  const {
    url,
    batchSize = 20,
    flushIntervalMs = 2000,
    fetchImpl = fetch,
  } = options;
  let buffer: string[] = [];
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    if (buffer.length === 0) return;
    const lines = buffer;
    buffer = [];
    fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: lines.join('\n'),
    }).catch(() => {
      // Best-effort only — see file comment.
    });
  };

  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      buffer.push(chunk.toString().trim());
      if (buffer.length >= batchSize) {
        flush();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, flushIntervalMs);
        timer.unref();
      }
      callback();
    },
    final(callback) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      flush();
      callback();
    },
  });
}
