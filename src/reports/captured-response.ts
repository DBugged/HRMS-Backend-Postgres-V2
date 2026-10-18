// Purpose: a stand-in for an HTTP response that keeps what the report exporters write, so a report can be built as a
//   file in memory (to attach to an email) by the very same code that streams it to a browser.
// Responsibilities: implements just the bits sendReport() / renderPdfTable() touch - setHeader(), send(), and being
//   pipe()d into - and exposes the finished bytes. Reusing the real exporters keeps the branding, logo and watermark
//   identical to a download.
import { Writable } from 'stream';

export class CapturedResponse extends Writable {
  private chunks: Buffer[] = [];
  readonly headers: Record<string, string> = {};
  // Resolves with the whole file once the exporter has finished writing it.
  readonly done: Promise<Buffer>;
  private finishDone!: (b: Buffer) => void;

  constructor() {
    super();
    this.done = new Promise((resolve) => {
      this.finishDone = resolve;
    });
    this.on('finish', () => this.finishDone(Buffer.concat(this.chunks)));
  }

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }

  send(body: Buffer | Uint8Array | string) {
    this.chunks.push(Buffer.from(body as never));
    this.end();
    return this;
  }

  _write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
    this.chunks.push(Buffer.from(chunk));
    cb();
  }
}
