import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { captureException } from '../sentry';
import { AuditLogService } from '../../audit-log/audit-log.service';
import {
  MULTER_FILE_TOO_LARGE,
  describeFileTooLarge,
} from '../../files/upload-errors';

// Prisma's own P2002 message ("Unique constraint failed on the fields:
// (`x`)") leaks the raw column name and isn't something a client should
// see. meta.target is the list of column names involved.
function duplicateFieldMessage(
  exception: Prisma.PrismaClientKnownRequestError,
): string {
  const target = exception.meta?.target;
  const fields = Array.isArray(target)
    ? target.join(', ')
    : typeof target === 'string'
      ? target
      : 'field';
  return `A record with this ${fields} already exists.`;
}

// Recognizes an error raised by body-parser (raw-body / http-errors): a
// string `type` such as 'entity.too.large' or 'entity.parse.failed', a 4xx
// `status`, and `expose: true` (http-errors' flag for a client-safe message).
function asBodyParserError(
  exception: unknown,
): { type: string; status: number; message: string } | null {
  if (!(exception instanceof Error)) return null;
  const e = exception as Error & {
    type?: unknown;
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
  };
  const status =
    typeof e.status === 'number'
      ? e.status
      : typeof e.statusCode === 'number'
        ? e.statusCode
        : undefined;
  if (
    typeof e.type !== 'string' ||
    e.expose !== true ||
    status === undefined ||
    status < 400 ||
    status > 499
  ) {
    return null;
  }
  return { type: e.type, status, message: e.message };
}

// "45 seconds" / "1 minute" / "3 minutes": how long a caller who was rate-limited has to wait.
export function describeWait(seconds: number): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

// Every error response, HttpException or not, comes out in this exact
// shape. statusCode/message/error are Nest's own fields (preserved
// as-is — many e2e tests assert res.body.message directly), path/
// timestamp are new. Never leaks a raw stack trace or driver error to
// the client for a non-HttpException (5xx) — those are logged
// server-side only.
// Routes whose refused calls are worth a place in the audit trail: payroll and the data it is built from.
const AUDITED_DENIAL_PREFIXES = [
  '/payroll',
  '/reports/payroll',
  '/employee-salary',
  '/statutory-config',
  '/tax-slabs',
  '/leave-balances',
  '/audit-logs',
];

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly auditLogService: AuditLogService) {}

  // A signed-in user refused (403) on a sensitive route is recorded as ACCESS_DENIED / FAILURE, so attempts to reach
  // payroll without permission leave a trace. The write is awaited (a few milliseconds, only on a refused call to these
  // routes) so that it is on record before the caller sees the refusal; it never fails the response (log() swallows
  // its own errors).
  private auditDenial(
    request: Request,
    status: number,
    message: unknown,
  ): Promise<void> | undefined {
    if (status !== 403) return undefined;
    const user = (
      request as Request & {
        user?: { id?: string; organizationId?: string };
      }
    ).user;
    const path = (request.originalUrl ?? request.url).split('?')[0];
    if (!user?.id || !user.organizationId) return undefined;
    if (!AUDITED_DENIAL_PREFIXES.some((p) => path.startsWith(p))) {
      return undefined;
    }
    return this.auditLogService.log({
      actorId: user.id,
      organizationId: user.organizationId,
      action: 'ACCESS_DENIED',
      module: 'PAYROLL',
      outcome: 'FAILURE',
      details: {
        method: request.method,
        path,
        message: Array.isArray(message) ? message.join('; ') : String(message),
      },
    });
  }

  async catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    // A unique-constraint violation is a client-caused 409, not a server
    // fault — e.g. two employees both setting the same unique value.
    // Without this, it fell through to the generic 500 branch below and
    // leaked nothing useful to the caller.
    const isDuplicateKey =
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === 'P2002';
    // body-parser rejects a request before any controller runs (body over
    // the size limit, malformed JSON, bad charset) with a plain Error
    // carrying `type` + a 4xx `status` and `expose: true`. Those are client
    // errors — an oversized body used to come back as a 500.
    const bodyParserError = asBodyParserError(exception);
    const status = isHttp
      ? exception.getStatus()
      : isDuplicateKey
        ? HttpStatus.CONFLICT
        : bodyParserError
          ? bodyParserError.status
          : HttpStatus.INTERNAL_SERVER_ERROR;

    let message: string | string[];
    let error: string;
    if (isHttp) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
        error = exception.name;
      } else {
        const b = body as { message?: string | string[]; error?: string };
        message = b.message ?? exception.message;
        error = b.error ?? exception.name;
      }
      // An upload over the category's size limit arrives as a bare "File too large"; say what the limit is.
      if (status === 413 && message === MULTER_FILE_TOO_LARGE) {
        message = describeFileTooLarge(request.originalUrl ?? request.url);
      }
    } else if (isDuplicateKey) {
      message = duplicateFieldMessage(exception);
      error = 'Conflict';
    } else if (bodyParserError) {
      if (bodyParserError.type === 'entity.too.large') {
        message = 'Request body is too large.';
        error = 'Payload Too Large';
      } else {
        message = bodyParserError.message;
        error = 'Bad Request';
      }
    } else {
      message = 'Internal server error';
      error = 'Internal Server Error';
      this.logger.error(
        exception instanceof Error ? exception.stack : exception,
      );
      captureException(exception);
    }

    // Rate-limited (429): say how long to wait, from the Retry-After the throttler set, instead of "ThrottlerException: Too Many
    // Requests". A 429 that already carries its own wording (for example a sign-in lockout) is left as written.
    let retryAfterSeconds: number | undefined;
    if (status === HttpStatus.TOO_MANY_REQUESTS && typeof message === 'string' && /^ThrottlerException|^Too Many Requests/i.test(message)) {
      const raw = Number(response.getHeader('Retry-After'));
      if (Number.isFinite(raw) && raw > 0) {
        retryAfterSeconds = Math.ceil(raw);
        message = `Too many attempts. Please wait ${describeWait(raw)} and try again.`;
      } else {
        message = 'Too many attempts. Please wait a moment and try again.';
      }
      error = 'Too Many Requests';
    }

    // Only a refused call to a sensitive route waits for its audit write; every other error is answered at once.
    const denial = this.auditDenial(request, status, message);
    if (denial) await denial;

    response.status(status).json({
      statusCode: status,
      message,
      error,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
