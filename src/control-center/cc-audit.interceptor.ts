// Purpose: writes one audit-log row for every successful change (POST/PUT/PATCH/DELETE) a Super Admin makes in the panel.
// Important: only requests that passed CcAuthGuard (req.superAdmin set) are recorded, so HRMS traffic is untouched.
//   Passwords and tokens in the body are blanked before it is stored.
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { tap } from 'rxjs';
import type { CcRequest } from './cc-auth.guard';
import { CcSupportService } from './cc-support.service';

const SECRET = /pass|token|secret/i;
const redact = (v: unknown): unknown =>
  v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET.test(k) ? '[hidden]' : x])) : v;

@Injectable()
export class CcAuditInterceptor implements NestInterceptor {
  constructor(private readonly support: CcSupportService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<CcRequest & Request>();
    return next.handle().pipe(
      tap(() => {
        const actor = req.superAdmin;
        if (!actor || req.method === 'GET') return;
        const path = String(req.route?.path ?? req.path).replace(/^\/?api\/v1\/?/, '');
        const params = req.params as Record<string, string>;
        void this.support
          .record({
            actor, ip: req.ip, userAgent: req.headers['user-agent'], action: `${req.method} /${path}`,
            entityType: path.split('/')[0], entityId: params.id ?? params.key ?? '', after: redact(req.body), requestId: String(req.headers['x-request-id'] ?? ''),
          })
          .catch(() => undefined); // an audit hiccup must never fail the admin's action
      }),
    );
  }
}
