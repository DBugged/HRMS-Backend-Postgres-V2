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
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditModule, Prisma } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmailService } from '../notifications/email.service';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';
import { CreateEmailTemplateDto } from './dto/create-email-template.dto';
import { SendEmailTemplateDto } from './dto/send-email-template.dto';
import { EMAIL_TEMPLATE_DEFAULTS } from './email-template-defaults';
import { renderTemplate } from './render-template';
import { wrapAll } from '../common/pagination';
import { companyLogoImgTag } from './company-logo';

type Actor = { id: string };

export interface EmailSignature {
  id: string;
  name: string;
  html: string;
  isDefault: boolean;
}

@Injectable()
export class EmailTemplatesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
    private readonly emailService: EmailService,
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
          isCustom: false,
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
        // '' from the frontend's "Use default" option means "clear it back
        // to null" — undefined (the key omitted) means "leave unchanged".
        ...(dto.signatureId !== undefined && {
          signatureId: dto.signatureId || null,
        }),
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

  // Auto-derives occasionKey from name (BIRTHDAY-style SCREAMING_SNAKE_CASE)
  // rather than asking the admin to pick a machine key themselves — it's
  // only ever read back by id from here on (create/delete/send all take
  // id, not occasionKey), so its exact value doesn't matter beyond
  // satisfying the @@unique([organizationId, occasionKey]) constraint.
  private async uniqueOccasionKey(
    name: string,
    organizationId: string,
  ): Promise<string> {
    const base =
      name
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'CUSTOM';
    let candidate = base;
    let suffix = 2;
    while (
      await this.scopedPrisma.emailTemplate.findFirst({
        where: { organizationId, occasionKey: candidate },
      })
    ) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  async create(
    dto: CreateEmailTemplateDto,
    organizationId: string,
    actorId?: string,
  ) {
    const name = dto.name.trim();
    if (!name) throw new BadRequestException('Template name is required.');
    const occasionKey = await this.uniqueOccasionKey(name, organizationId);

    const template = await this.scopedPrisma.emailTemplate.create({
      data: {
        organizationId,
        occasionKey,
        name,
        subject: dto.subject,
        bodyHtml: dto.bodyHtml,
        ccAllActive: dto.ccAllActive ?? false,
        isCustom: true,
        signatureId: dto.signatureId || null,
      },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'EMAIL_TEMPLATE_CREATED',
        module: AuditModule.NOTIFICATION,
        organizationId,
        targetId: template.id,
        details: { name: template.name, occasionKey },
      });
    }

    return template;
  }

  async delete(id: string, organizationId: string, actorId?: string) {
    const template = await this.scopedPrisma.emailTemplate.findFirst({
      where: { id, organizationId },
    });
    if (!template) throw new NotFoundException('Email template not found.');
    if (!template.isCustom) {
      throw new BadRequestException(
        'Built-in templates can’t be deleted — disable them instead.',
      );
    }

    await this.scopedPrisma.emailTemplate.deleteMany({
      where: { id, organizationId },
    });

    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'EMAIL_TEMPLATE_DELETED',
        module: AuditModule.NOTIFICATION,
        organizationId,
        targetId: id,
        details: { name: template.name },
      });
    }

    return { success: true, message: 'Email template deleted' };
  }

  // Manual send — the only trigger a custom (isCustom) template has, since
  // it isn't wired into any cron/event the way Birthday/Work Anniversary
  // are. Renders per-recipient (employeeName varies) but otherwise reuses
  // the exact same render()/orgVariables shape HrEventsService already
  // uses for the seeded occasions, so a template author sees identical
  // {{placeholder}} behavior regardless of which kind of template they're
  // editing. One employee's send failure (bad email, etc.) doesn't abort
  // the rest — same Promise.allSettled isolation used elsewhere this batch
  // of features (ReimbursementsService.bulkReview, PayrollService.calculate).
  async sendManual(
    id: string,
    dto: SendEmailTemplateDto,
    organizationId: string,
    actor: Actor,
  ) {
    const template = await this.scopedPrisma.emailTemplate.findFirst({
      where: { id, organizationId },
    });
    if (!template) throw new NotFoundException('Email template not found.');
    if (!template.isActive) {
      throw new BadRequestException(
        'This template is disabled — enable it before sending.',
      );
    }

    // CC ids that are also in the "to" list are dropped — that recipient
    // already gets the email as a primary "to", so CCing them too would
    // just duplicate the address on the same message.
    const ccIds = (dto.ccEmployeeIds ?? []).filter(
      (id) => !dto.employeeIds.includes(id),
    );

    const [organization, employees, ccEmployees] = await Promise.all([
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: {
          companyName: true,
          phone: true,
          website: true,
          contactEmail: true,
          registeredAddress: true,
          emailLogoUrl: true,
        },
      }),
      this.scopedPrisma.user.findMany({
        where: { id: { in: dto.employeeIds }, organizationId },
        select: { id: true, name: true, email: true },
      }),
      ccIds.length
        ? this.scopedPrisma.user.findMany({
            where: { id: { in: ccIds }, organizationId },
            select: { email: true },
          })
        : Promise.resolve([]),
    ]);
    const orgVariables = {
      companyName: organization?.companyName ?? '',
      companyPhone: organization?.phone ?? '',
      companyWebsite: organization?.website ?? '',
      companyEmail: organization?.contactEmail ?? '',
      companyAddress: organization?.registeredAddress ?? '',
      companyLogo: companyLogoImgTag(
        organizationId,
        organization?.emailLogoUrl,
      ),
    };
    const cc = ccEmployees.map((e) => e.email);

    const results = await Promise.allSettled(
      employees.map(async (employee) => {
        const variables = { employeeName: employee.name, ...orgVariables };
        return this.emailService.send({
          to: employee.email,
          subject: renderTemplate(template.subject, variables),
          html: await this.appendSignature(
            renderTemplate(template.bodyHtml, variables),
            organizationId,
            variables,
            template.signatureId,
          ),
          ...(cc.length && { cc }),
        });
      }),
    );
    const sent = results.filter((r) => r.status === 'fulfilled').length;
    const failed = employees
      .filter((_, idx) => results[idx].status === 'rejected')
      .map((e) => e.name);

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMAIL_TEMPLATE_SENT',
      module: AuditModule.NOTIFICATION,
      organizationId,
      targetId: id,
      details: {
        name: template.name,
        recipientCount: employees.length,
        ccCount: cc.length,
        sent,
        failed: failed.length,
      },
    });

    return { sent, failed, requestedCount: dto.employeeIds.length };
  }

  // Pure {{key}} substitution — see render-template.ts. Exposed on the
  // service (rather than requiring every caller to import the free
  // function directly) so DI-based callers can reach it off the same
  // injected instance they use for lookups.
  render(template: string, variables: Record<string, string>): string {
    return renderTemplate(template, variables);
  }

  // Renders the org's active email template for `occasionKey`, falling back
  // to the caller's hardcoded subject/html when none is active (an org
  // predating this occasion's seeding, or one that's disabled the
  // template) — so a missing/disabled template degrades gracefully rather
  // than silently dropping the email. Generalized out of HrEventsService's
  // original private method (same name/shape) once every notification
  // email in the app started going through this, not just Birthday/Work
  // Anniversary. Whichever signature the template (or the fallback's
  // implicit "no template") resolves to is appended below the body — see
  // appendSignature().
  async renderOccasion(
    organizationId: string,
    occasionKey: string,
    variables: Record<string, string>,
    fallback: { subject: string; html: string },
  ): Promise<{ subject: string; html: string; ccAllActive: boolean }> {
    const template = await this.findActiveByOccasion(
      occasionKey,
      organizationId,
    );
    if (!template) {
      return {
        subject: fallback.subject,
        html: await this.appendSignature(
          fallback.html,
          organizationId,
          variables,
          null,
        ),
        ccAllActive: false,
      };
    }
    return {
      subject: this.render(template.subject, variables),
      html: await this.appendSignature(
        this.render(template.bodyHtml, variables),
        organizationId,
        variables,
        template.signatureId,
      ),
      ccAllActive: template.ccAllActive,
    };
  }

  // Appends the resolved signature (the template's own signatureId, or —
  // when null/not found in the org's current list — whichever one has
  // isDefault:true) below the rendered body. Not every org has one team
  // sending all mail (HR vs Payroll vs IT, say), so this is a *list* of
  // named signatures (Organization.emailSignatures), not one shared block
  // — each EmailTemplate picks which one it uses. Renders {{placeholder}}s
  // the same way the body itself does, but the signature's own variable
  // needs (companyPhone/companyWebsite/companyEmail/companyAddress/
  // companyLogo) are broader than what most occasion call sites bother
  // building for their own body — a leave-decision email, say, only ever
  // passes employeeName/decision/dates — so this fetches the full company
  // variable set itself rather than relying on the caller to have included
  // it. Caller-supplied `variables` win on any key overlap.
  private async appendSignature(
    html: string,
    organizationId: string,
    variables: Record<string, string>,
    signatureId: string | null,
  ): Promise<string> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: {
        emailSignatures: true,
        companyName: true,
        phone: true,
        website: true,
        contactEmail: true,
        registeredAddress: true,
        emailLogoUrl: true,
      },
    });
    const signatures = (org?.emailSignatures ??
      []) as unknown as EmailSignature[];
    const resolved =
      (signatureId && signatures.find((s) => s.id === signatureId)) ||
      signatures.find((s) => s.isDefault) ||
      null;
    const signatureHtml = resolved?.html?.trim();
    if (!signatureHtml) return html;
    const companyVariables = {
      companyName: org?.companyName ?? '',
      companyPhone: org?.phone ?? '',
      companyWebsite: org?.website ?? '',
      companyEmail: org?.contactEmail ?? '',
      companyAddress: org?.registeredAddress ?? '',
      companyLogo: companyLogoImgTag(organizationId, org?.emailLogoUrl),
    };
    return `${html}${this.render(signatureHtml, { ...companyVariables, ...variables })}`;
  }

  async listSignatures(
    organizationId: string,
  ): Promise<{ data: EmailSignature[] }> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { emailSignatures: true },
    });
    return {
      data: (org?.emailSignatures ?? []) as unknown as EmailSignature[],
    };
  }

  async createSignature(
    dto: { name: string; html: string },
    organizationId: string,
    actorId: string,
  ): Promise<EmailSignature> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { emailSignatures: true },
    });
    const signatures = (org?.emailSignatures ??
      []) as unknown as EmailSignature[];
    const signature: EmailSignature = {
      id: crypto.randomUUID(),
      name: dto.name.trim() || 'Untitled Signature',
      html: dto.html,
      // The very first signature an org creates becomes the default
      // automatically — otherwise every template would silently get no
      // signature at all until an admin remembers to flip one on.
      isDefault: signatures.length === 0,
    };
    await this.scopedPrisma.organization.updateMany({
      where: { id: organizationId },
      data: {
        emailSignatures: [
          ...signatures,
          signature,
        ] as unknown as Prisma.InputJsonValue,
      },
    });
    await this.auditLogService.log({
      actorId,
      action: 'EMAIL_SIGNATURE_CREATED',
      module: AuditModule.NOTIFICATION,
      organizationId,
      targetId: signature.id,
      details: { name: signature.name },
    });
    return signature;
  }

  async updateSignatureById(
    id: string,
    dto: { name?: string; html?: string; isDefault?: boolean },
    organizationId: string,
    actorId: string,
  ): Promise<EmailSignature> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { emailSignatures: true },
    });
    const signatures = (org?.emailSignatures ??
      []) as unknown as EmailSignature[];
    const existing = signatures.find((s) => s.id === id);
    if (!existing) throw new NotFoundException('Signature not found.');
    // Exactly one signature is ever isDefault:true — setting this one
    // clears the flag on every other, same "radio button" invariant as
    // Organization.signatories' isPrimary.
    const next = signatures.map((s) => {
      if (s.id === id) {
        return {
          ...s,
          ...(dto.name !== undefined && { name: dto.name.trim() || s.name }),
          ...(dto.html !== undefined && { html: dto.html }),
          ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        };
      }
      return dto.isDefault ? { ...s, isDefault: false } : s;
    });
    await this.scopedPrisma.organization.updateMany({
      where: { id: organizationId },
      data: { emailSignatures: next as unknown as Prisma.InputJsonValue },
    });
    await this.auditLogService.log({
      actorId,
      action: 'EMAIL_SIGNATURE_UPDATED',
      module: AuditModule.NOTIFICATION,
      organizationId,
      targetId: id,
      details: {},
    });
    return next.find((s) => s.id === id)!;
  }

  async deleteSignature(
    id: string,
    organizationId: string,
    actorId: string,
  ): Promise<{ success: true; message: string }> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { emailSignatures: true },
    });
    const signatures = (org?.emailSignatures ??
      []) as unknown as EmailSignature[];
    const existing = signatures.find((s) => s.id === id);
    if (!existing) throw new NotFoundException('Signature not found.');
    const remaining = signatures.filter((s) => s.id !== id);
    // Losing the default shouldn't leave the list with none — promote
    // whichever one is now first, if any are left. Same pattern as
    // SignatoryStep's own removeRow on the frontend.
    if (existing.isDefault && remaining.length)
      remaining[0] = { ...remaining[0], isDefault: true };
    await this.scopedPrisma.organization.updateMany({
      where: { id: organizationId },
      data: { emailSignatures: remaining as unknown as Prisma.InputJsonValue },
    });
    await this.auditLogService.log({
      actorId,
      action: 'EMAIL_SIGNATURE_DELETED',
      module: AuditModule.NOTIFICATION,
      organizationId,
      targetId: id,
      details: { name: existing.name },
    });
    return { success: true, message: 'Signature deleted' };
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
