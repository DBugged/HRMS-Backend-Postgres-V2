// Purpose: Org-scoped, occasion-based email templates (birthday wishes, work anniversaries, future
// occasions) — registration-time default seeding, CRUD, and the {{placeholder}} render() used by
// HrEventsService (and any future occasion-driven sender) to turn a template + variables into real
// subject/body text.
// Responsibilities: Owns seedDefaults() (called from AuthService.register()'s transaction, same
// integration point as LeaveTypesService/HolidaysService/SalaryComponentsService) and the
// @@unique([organizationId, occasionKey]) v1 invariant of "one active template per occasion per org".
// Important: occasionKey is a free-form string, not a Prisma enum, so a new occasion never needs a
// migration — only a new default row (email-template-defaults.ts) and a caller. render() is a pure,
// dependency-free {{key}} substitution — see render-template.ts.
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditModule, Prisma } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';
import { EMAIL_TEMPLATE_DEFAULTS } from './email-template-defaults';
import { renderTemplate } from './render-template';
import { wrapAll } from '../common/pagination';

@Injectable()
export class EmailTemplatesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
  ) {}

  // Every new org starts with the standard occasion set (Birthday, Work
  // Anniversary) instead of an empty Email Templates page — admin can edit
  // subject/body/cc from there afterward. Same registration-time
  // integration point as LeaveTypesService/HolidaysService/
  // SalaryComponentsService.seedDefaults.
  async seedDefaults(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    for (const def of EMAIL_TEMPLATE_DEFAULTS) {
      await tx.emailTemplate.create({
        data: {
          organizationId,
          occasionKey: def.occasionKey,
          name: def.name,
          subject: def.subject,
          bodyHtml: def.bodyHtml,
          ccAllActive: def.ccAllActive,
        },
      });
    }
  }

  async findAll(organizationId: string) {
    const data = await this.scopedPrisma.emailTemplate.findMany({
      where: { organizationId },
      orderBy: { occasionKey: 'asc' },
    });
    return wrapAll(data);
  }

  async findByOccasion(occasionKey: string, organizationId: string) {
    return this.findByOccasionOrThrow(occasionKey, organizationId);
  }

  // Looks up the org's active template for an occasion, or null if none
  // exists — used by callers (HrEventsService) that need to fall back to a
  // hardcoded string rather than fail when an org has no active template
  // for that occasion.
  async findActiveByOccasion(occasionKey: string, organizationId: string) {
    return this.scopedPrisma.emailTemplate.findFirst({
      where: { organizationId, occasionKey, isActive: true },
    });
  }

  async update(
    occasionKey: string,
    dto: UpdateEmailTemplateDto,
    organizationId: string,
    actorId?: string,
  ) {
    await this.findByOccasionOrThrow(occasionKey, organizationId);

    await this.scopedPrisma.emailTemplate.updateMany({
      where: { organizationId, occasionKey },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.subject !== undefined && { subject: dto.subject }),
        ...(dto.bodyHtml !== undefined && { bodyHtml: dto.bodyHtml }),
        ...(dto.ccAllActive !== undefined && {
          ccAllActive: dto.ccAllActive,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'EMAIL_TEMPLATE_UPDATED',
        // No dedicated EMAIL_TEMPLATE value exists in the AuditModule enum
        // (AUTH/EMPLOYEE/ATTENDANCE/LEAVE/PAYROLL/DEPARTMENT/DOCUMENT/
        // HOLIDAY/NOTIFICATION/ORGANIZATION) — NOTIFICATION is the closest
        // fit since these templates drive outbound HR notification emails.
        // Flagged in the delivery report rather than widening the enum
        // for a single new module.
        module: AuditModule.NOTIFICATION,
        organizationId,
        targetId: occasionKey,
        details: {
          occasionKey,
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        },
      });
    }

    return this.findByOccasionOrThrow(occasionKey, organizationId);
  }

  // Pure {{key}} substitution — see render-template.ts. Exposed on the
  // service (rather than requiring every caller to import the free
  // function directly) so DI-based callers can reach it off the same
  // injected instance they use for lookups.
  render(template: string, variables: Record<string, string>): string {
    return renderTemplate(template, variables);
  }

  private async findByOccasionOrThrow(
    occasionKey: string,
    organizationId: string,
  ) {
    const template = await this.scopedPrisma.emailTemplate.findFirst({
      where: { organizationId, occasionKey },
    });
    if (!template) {
      throw new NotFoundException(
        `No email template found for occasion '${occasionKey}'.`,
      );
    }
    return template;
  }
}
