// Purpose: Shared fire-and-forget helpers for the privacy audit trail of sensitive-data access (documents, payslips, exports).
// Responsibilities: auditSensitive() logs action + category + target ids only (never values) without ever failing or
// delaying the request; ExportAuditInterceptor logs every report/export download and auto-records statutory and bank
// export files as data sharing.
// Important: PrivacyAuditService.log() already swallows its own errors; the extra catch here also covers a sync throw.
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { PrivacyAuditService } from '../privacy/privacy-audit.service';
import { PrivacyService } from '../privacy/privacy.service';

export interface AuditCaller {
  id: string;
  role: string;
  organizationId: string;
}

export function auditSensitive(
  audit: PrivacyAuditService,
  caller: AuditCaller,
  input: {
    action: string;
    category: string;
    targetUserId?: string | null;
    entity?: string;
    entityId?: string;
    meta?: Record<string, unknown>;
  },
): void {
  try {
    void audit
      .log({
        organizationId: caller.organizationId,
        actorId: caller.id,
        actorRole: caller.role,
        ...input,
      })
      .catch(() => undefined);
  } catch {
    // never let audit logging break the request
  }
}

// Payroll/statutory/bank files that leave the system for a third party (regulator portal, bank).
const SHARING_BY_ROUTE: Record<
  string,
  { recipient: string; dataCategory: string; purpose: string }
> = {
  pf: {
    recipient: 'EPFO (PF statutory filing)',
    dataCategory: 'STATUTORY',
    purpose: 'PF statutory export file',
  },
  esi: {
    recipient: 'ESIC (ESI statutory filing)',
    dataCategory: 'STATUTORY',
    purpose: 'ESI statutory export file',
  },
  pt: {
    recipient: 'State PT authority',
    dataCategory: 'STATUTORY',
    purpose: 'Professional tax export file',
  },
  'income-tax': {
    recipient: 'Income tax department (TDS)',
    dataCategory: 'STATUTORY',
    purpose: 'Income tax export file',
  },
  form16: {
    recipient: 'Income tax department (Form 16)',
    dataCategory: 'STATUTORY',
    purpose: 'Form 16 export file',
  },
  'bank-transfer': {
    recipient: 'Bank (salary transfer)',
    dataCategory: 'BANK',
    purpose: 'Bank transfer export file',
  },
};

@Injectable()
export class ExportAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly audit: PrivacyAuditService,
    private readonly privacy: PrivacyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<
      Request & {
        user?: AuditCaller;
      }
    >();
    return next.handle().pipe(
      tap(() => {
        const user = req.user;
        if (!user?.organizationId) return;
        // Route path only (no query string values), e.g. /reports/payroll/pf
        const route = String(req.path ?? '').replace(/\/+$/, '');
        const last = route.split('/').pop() ?? '';
        const format =
          typeof req.query?.format === 'string' ? req.query.format : 'xlsx';
        try {
          void this.audit
            .log({
              organizationId: user.organizationId,
              actorId: user.id,
              actorRole: user.role,
              action: 'REPORT_EXPORTED',
              category: 'EXPORT',
              entity: 'Report',
              entityId: route.slice(0, 120),
              ip: req.ip,
              userAgent: req.headers?.['user-agent'],
              meta: { format },
            })
            .catch(() => undefined);
          const sharing = route.includes('/reports/payroll/')
            ? SHARING_BY_ROUTE[last]
            : undefined;
          if (sharing) {
            void this.privacy
              .recordSystemSharing(
                user.organizationId,
                { ...sharing, integration: 'export' },
                user.id,
              )
              .catch(() => undefined);
          }
        } catch {
          // audit must never break an export
        }
      }),
    );
  }
}
