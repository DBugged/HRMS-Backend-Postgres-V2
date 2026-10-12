// Purpose: Carries the current request's id, client IP and signed-in user to code that has no access to the request.
// Responsibilities: an Express middleware that opens an AsyncLocalStorage scope per request and gives it a request id
//   (the caller's X-Request-Id when it is a sane value, else a new UUID, echoed back on the response), plus a reader.
// Important: used by AuditLogService so every audit entry records where it came from without every caller passing it.
// The user is read lazily: authentication runs after this middleware.
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

interface Store {
  requestId: string;
  ip: string;
  req: Request;
}

const storage = new AsyncLocalStorage<Store>();

const SANE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,100}$/;

export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers['x-request-id'];
  const requestId =
    typeof incoming === 'string' && SANE_REQUEST_ID.test(incoming)
      ? incoming
      : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  storage.run({ requestId, ip: req.ip ?? '', req }, () => next());
}

export interface CurrentRequest {
  requestId: string;
  ip: string;
  user?: { id: string; role: string };
}

export function currentRequest(): CurrentRequest | undefined {
  const store = storage.getStore();
  if (!store) return undefined;
  const user = (
    store.req as Request & { user?: { id?: string; role?: string } }
  ).user;
  return {
    requestId: store.requestId,
    ip: store.ip,
    user: user?.id && user.role ? { id: user.id, role: user.role } : undefined,
  };
}
