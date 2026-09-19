// Purpose: Global sanity checks on every JSON request body, before any controller/DTO runs.
// Responsibilities: rejects a top-level JSON array where an object is expected (it slipped past the DTO
//   validation and surfaced as a 500) and caps the length of any string value, so a multi-thousand-character
//   "name" can't be stored. Long free-text fields (HTML/body/message/notes...) get a much higher cap.
// Important: Applied via APP_INTERCEPTOR so it also covers the e2e app, not just main.ts. File uploads are
//   multipart and never reach this check with a JSON body.
import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';

// Anything that isn't an obviously long-form field: names, labels, codes, URLs, formulas, emails...
export const MAX_SHORT_STRING = 2000;
// Keys that legitimately hold long text (template bodies, HTML, messages, notes, addresses).
export const MAX_LONG_STRING = 200000;
const LONG_TEXT_KEY = /html|body|text|content|signature|intro|boundary/i;
// Short-note-like fields (reasons, remarks, comments, addresses...) get a moderate cap.
export const MAX_NOTE_STRING = 10000;
const NOTE_TEXT_KEY =
  /message|description|remarks|reason|notes|comment|details|address/i;

function findTooLong(value: unknown, key = '', depth = 0): string | null {
  if (depth > 12) return null;
  if (typeof value === 'string') {
    const cap = LONG_TEXT_KEY.test(key)
      ? MAX_LONG_STRING
      : NOTE_TEXT_KEY.test(key)
        ? MAX_NOTE_STRING
        : MAX_SHORT_STRING;
    return value.length > cap ? key || 'value' : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = findTooLong(v, key, depth + 1);
      if (hit) return hit;
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const hit = findTooLong(v, k, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

@Injectable()
export class RequestSanityInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const body: unknown = req.body;
    if (Array.isArray(body)) {
      throw new BadRequestException('Request body must be a JSON object.');
    }
    const tooLong = findTooLong(body);
    if (tooLong) {
      throw new BadRequestException(`"${tooLong}" is too long.`);
    }
    return next.handle();
  }
}
