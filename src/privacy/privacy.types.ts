import type { Request } from 'express';
import type { User } from '@prisma/client';

export type Caller = Omit<User, 'password'>;

// IP / user-agent captured from the request for the privacy audit trail.
export interface ReqCtx {
  ip?: string;
  userAgent?: string;
}

export function reqCtx(req: Request): ReqCtx {
  const ua = req.headers['user-agent'];
  return { ip: req.ip ?? '', userAgent: typeof ua === 'string' ? ua : '' };
}
