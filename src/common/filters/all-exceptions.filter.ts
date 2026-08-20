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

// Every error response, HttpException or not, comes out in this exact
// shape. statusCode/message/error are Nest's own fields (preserved
// as-is — many e2e tests assert res.body.message directly), path/
// timestamp are new. Never leaks a raw stack trace or driver error to
// the client for a non-HttpException (5xx) — those are logged
// server-side only.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    // A unique-constraint violation is a client-caused 409, not a server
    // fault — e.g. two employees both clearing/setting the same
    // officialEmail. Without this, it fell through to the generic 500
    // branch below and leaked nothing useful to the caller.
    const isDuplicateKey =
      exception instanceof Prisma.PrismaClientKnownRequestError &&
      exception.code === 'P2002';
    const status = isHttp
      ? exception.getStatus()
      : isDuplicateKey
        ? HttpStatus.CONFLICT
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
    } else if (isDuplicateKey) {
      message = duplicateFieldMessage(exception);
      error = 'Conflict';
    } else {
      message = 'Internal server error';
      error = 'Internal Server Error';
      this.logger.error(
        exception instanceof Error ? exception.stack : exception,
      );
      captureException(exception);
    }

    response.status(status).json({
      statusCode: status,
      message,
      error,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
