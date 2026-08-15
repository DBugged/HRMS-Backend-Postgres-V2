import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { captureException } from '../sentry';

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
    const status = isHttp
      ? exception.getStatus()
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
