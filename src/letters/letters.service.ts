// Purpose: Generates a letter PDF from an org's LetterTemplate — fetches the real employee/org/computed
//   data a template's dataProfile needs, substitutes it into the template's {{placeholder}} title/body,
//   issues the org's configured document number for it (making Document Numbering's entries actually get
//   used, the same way employeeId/payslip already are), and renders the PDF.
// Important: view-scoped the same way EmployeeTimelineService is — self, or ADMIN/HR see anyone, MANAGER
//   only their own department (enforced here; the self-or-role split itself is the controller's guard).
//   Content is fully admin-authored via LetterTemplatesService — nothing here hardcodes letter wording;
//   only the *shape* of the 4 dataProfiles (BASIC/EXIT/PAYROLL/SETTLEMENT) is fixed, since each names a
//   real prerequisite record (OffboardingCase/PayrollRun/Settlement) that can't be invented from nothing.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditModule,
  LetterDataProfile,
  PayrollRunStatus,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { readStoredFile } from '../files/file-storage.config';
import { issueDocumentNumber } from '../organizations/document-numbering';
import { formatDateDisplay } from '../payroll/format-date';
import { amountInWords } from '../payroll/number-to-words';
import { LetterPdfService } from './letter-pdf.service';
import { LetterTemplatesService } from '../letter-templates/letter-templates.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';

type Actor = Omit<User, 'password'>;

const MONTHS = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const PAID_OUT_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.LOCKED,
  PayrollRunStatus.PAID,
];

@Injectable()
export class LettersService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly pdfService: LetterPdfService,
    private readonly auditLogService: AuditLogService,
    private readonly letterTemplatesService: LetterTemplatesService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly emailService: EmailService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  // Powers the Letters & Certificates tab's list — which of the org's
  // active templates this employee can actually see, given the real
  // prerequisite record each dataProfile needs. BASIC (Offer/Appointment)
  // is unlocked from day one; EXIT/PAYROLL/SETTLEMENT need an
  // OffboardingCase/paid-out PayrollRun/Settlement to exist first — the
  // exact same existence checks generate() already throws 400 on, just
  // turned into a boolean instead of an exception so the UI can show
  // locked ones greyed out rather than surfacing a failed download.
  async listForEmployee(
    employeeId: string,
    actor: Actor,
    organizationId: string,
  ): Promise<
    Array<{
      key: string;
      name: string;
      dataProfile: LetterDataProfile;
      unlocked: boolean;
      reason: string | null;
    }>
  > {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
      select: { departmentId: true },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    if (
      actor.role === Role.MANAGER &&
      (actor.departmentId === null ||
        actor.departmentId !== employee.departmentId)
    ) {
      throw new ForbiddenException('Not authorized to view this employee.');
    }

    const { data: templates } =
      await this.letterTemplatesService.findAll(organizationId);
    const activeTemplates = templates.filter((t) => t.isActive);

    const [hasOffboardingCase, hasPaidPayrollRun, hasSettlement] =
      await Promise.all([
        this.scopedPrisma.offboardingCase
          .findFirst({
            where: { organizationId, employeeId },
            select: { id: true },
          })
          .then(Boolean),
        this.scopedPrisma.payrollRun
          .findFirst({
            where: {
              organizationId,
              employeeId,
              isFinalSettlement: false,
              status: { in: PAID_OUT_STATUSES },
            },
            select: { id: true },
          })
          .then(Boolean),
        this.scopedPrisma.settlement
          .findFirst({
            where: { organizationId, employeeId },
            select: { id: true },
          })
          .then(Boolean),
      ]);

    const UNLOCK_BY_PROFILE: Record<
      LetterDataProfile,
      { unlocked: boolean; reason: string }
    > = {
      [LetterDataProfile.BASIC]: { unlocked: true, reason: '' },
      [LetterDataProfile.EXIT]: {
        unlocked: hasOffboardingCase,
        reason: 'Available once offboarding is initiated for this employee.',
      },
      [LetterDataProfile.PAYROLL]: {
        unlocked: hasPaidPayrollRun,
        reason:
          'Available once a payroll run has been processed for this employee.',
      },
      [LetterDataProfile.SETTLEMENT]: {
        unlocked: hasSettlement,
        reason: 'Available once a Full & Final Settlement has been calculated.',
      },
    };

    return activeTemplates.map((t) => {
      const gate = UNLOCK_BY_PROFILE[t.dataProfile];
      return {
        key: t.key,
        name: t.name,
        dataProfile: t.dataProfile,
        unlocked: gate.unlocked,
        reason: gate.unlocked ? null : gate.reason,
      };
    });
  }

  // Shared by generate() and previewContent() — fetches the real employee/
  // org/dataProfile-specific data and renders the template's {{placeholder}}
  // title/body into final text. No side effects (no document number issued,
  // no PDF rendered) so previewContent() can call this freely for an
  // editable-text preview without burning a document number on every call.
  private async computeLetterContent(
    employeeId: string,
    key: string,
    actor: Actor,
    organizationId: string,
  ) {
    const template = await this.letterTemplatesService.findActiveByKey(
      key,
      organizationId,
    );
    if (!template) {
      throw new BadRequestException(
        `No active letter template found for '${key}' — configure one in Organization Settings > Letter Templates.`,
      );
    }

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
      include: { department: { select: { name: true } } },
    });
    if (!employee) throw new NotFoundException('Employee not found.');

    // Same view-scoping rule as EmployeeTimelineService.assertCanView — HR/
    // ADMIN see anyone, a MANAGER only their own department, an EMPLOYEE
    // only themselves (self-or-role already enforced at the controller).
    if (
      actor.role === Role.MANAGER &&
      (actor.departmentId === null ||
        actor.departmentId !== employee.departmentId)
    ) {
      throw new ForbiddenException('Not authorized to view this employee.');
    }

    const organization = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: {
        companyName: true,
        registeredAddress: true,
        companyLogoUrl: true,
        signatories: true,
        policies: true,
      },
    });
    if (!organization) throw new NotFoundException('Organization not found.');
    const companyName = organization.companyName || 'the Company';
    const policies = (organization.policies ?? {}) as {
      currencySymbol?: string;
    };
    const rawSymbol = policies.currencySymbol || '₹';
    // Same fallback payslip-pdf.service.ts already uses: pdfkit's bundled
    // fonts (including the Roboto subset embedded by letter-pdf.service.ts)
    // don't reliably carry the ₹ glyph, so a non-ASCII configured symbol
    // renders as a broken glyph — fall back to "Rs." rather than let that
    // happen (the web UI elsewhere still renders ₹ fine via the browser's
    // own font).
    // eslint-disable-next-line no-control-regex -- ASCII-only check, not a stray control char
    const currencySymbol = /^[\x00-\x7F]+$/.test(rawSymbol) ? rawSymbol : 'Rs.';
    const money = (n: number) =>
      `${currencySymbol}${currencySymbol === 'Rs.' ? ' ' : ''}${Math.round(n).toLocaleString('en-IN')}`;

    const firstName = employee.name.split(' ')[0] || employee.name;
    const variables: Record<string, string> = {
      employeeName: employee.name,
      firstName,
      employeeId: employee.employeeId,
      designation: employee.designation || '—',
      department: employee.department?.name || '—',
      employeeType: employee.employeeType,
      joiningDate: formatDateDisplay(employee.joiningDate),
      companyName,
      companyAddress: organization.registeredAddress || '',
      issueDate: formatDateDisplay(new Date()),
      // Available on every dataProfile (not just BASIC) since it's a
      // plain employee-record field, same as designation/department above
      // — backs Confirmation/Probation Extension Letter.
      probationEndDate: employee.probationEndDate
        ? formatDateDisplay(employee.probationEndDate)
        : '—',
    };

    switch (template.dataProfile) {
      case LetterDataProfile.EXIT: {
        const offboardingCase = await this.latestOffboardingCase(
          employeeId,
          organizationId,
        );
        variables.lastWorkingDay = formatDateDisplay(
          offboardingCase.lastWorkingDay,
        );
        // Backs Resignation Acceptance/Termination Letter — reason is
        // optional on OffboardingCase (HR isn't required to fill it in),
        // so this needs a fallback rather than rendering "undefined".
        variables.reason = offboardingCase.reason || 'personal reasons';
        variables.noticeDate = formatDateDisplay(offboardingCase.createdAt);
        break;
      }
      case LetterDataProfile.PAYROLL: {
        const run = await this.scopedPrisma.payrollRun.findFirst({
          where: {
            organizationId,
            employeeId,
            isFinalSettlement: false,
            status: { in: PAID_OUT_STATUSES },
          },
          orderBy: [{ year: 'desc' }, { month: 'desc' }],
        });
        if (!run) {
          throw new BadRequestException(
            'No processed payroll run found for this employee yet — this letter needs at least one.',
          );
        }
        variables.month = MONTHS[run.month];
        variables.year = String(run.year);
        variables.grossSalary = money(run.grossSalary);
        variables.netPay = money(run.netPay);
        variables.annualCTC = money(run.ctcMonthly * 12);
        break;
      }
      case LetterDataProfile.SETTLEMENT: {
        const settlement = await this.scopedPrisma.settlement.findFirst({
          where: { organizationId, employeeId },
          orderBy: { createdAt: 'desc' },
        });
        if (!settlement) {
          throw new BadRequestException(
            'No settlement found for this employee yet — calculate one first (Offboarding > Full & Final Settlement).',
          );
        }
        const totalDeductions =
          settlement.recoveriesAmount +
          settlement.loanBalanceRecovered +
          settlement.noticePeriodRecovery;
        variables.lastWorkingDay = formatDateDisplay(settlement.lastWorkingDay);
        variables.pendingSalary = money(settlement.pendingSalaryAmount);
        variables.leaveEncashment = money(settlement.leaveEncashmentAmount);
        variables.bonus = money(settlement.bonusAmount);
        variables.gratuity = money(settlement.gratuityAmount);
        variables.recoveries = money(settlement.recoveriesAmount);
        variables.loanRecovered = money(settlement.loanBalanceRecovered);
        variables.noticePeriodRecovery = money(settlement.noticePeriodRecovery);
        variables.totalDeductions = money(totalDeductions);
        variables.netPayable = money(settlement.netSettlementAmount);
        variables.netPayableInWords = amountInWords(
          Math.round(settlement.netSettlementAmount),
        );
        break;
      }
      case LetterDataProfile.BASIC:
      default:
        break;
    }

    const title = this.letterTemplatesService.render(template.title, variables);
    const renderedBody = this.letterTemplatesService.render(
      template.bodyText,
      variables,
    );
    const paragraphs = renderedBody
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    return { template, employee, organization, companyName, title, paragraphs };
  }

  // Text-only, no-side-effect counterpart to generate() — lets the Send
  // flow show HR the exact title/body they're about to email (as plain
  // editable text, not a PDF) without issuing a document number the way
  // every generate()/send() call does.
  async previewContent(
    employeeId: string,
    key: string,
    actor: Actor,
    organizationId: string,
  ): Promise<{ title: string; body: string }> {
    const { title, paragraphs } = await this.computeLetterContent(
      employeeId,
      key,
      actor,
      organizationId,
    );
    return { title, body: paragraphs.join('\n') };
  }

  async generate(
    employeeId: string,
    key: string,
    actor: Actor,
    organizationId: string,
    // HR's edited title/body for this one send — see SendLetterDto. Blank/
    // omitted falls back to the template's own rendered content, same as
    // before this existed. Only ever passed from send(); the plain
    // download route never overrides anything.
    overrides?: { title?: string; body?: string },
  ): Promise<{ buffer: Buffer; filename: string }> {
    const {
      template,
      employee,
      organization,
      companyName,
      title: computedTitle,
      paragraphs: computedParagraphs,
    } = await this.computeLetterContent(employeeId, key, actor, organizationId);

    const title = overrides?.title?.trim() || computedTitle;
    const paragraphs = overrides?.body?.trim()
      ? overrides.body
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
      : computedParagraphs;

    const documentNumber = await this.scopedPrisma.$transaction((tx) =>
      issueDocumentNumber(tx, organizationId, key),
    );

    const signatories = (organization.signatories ?? []) as Array<{
      name?: string;
      designation?: string;
      signatureUrl?: string | null;
      isPrimary?: boolean;
    }>;
    const primarySignatory =
      signatories.find((s) => s.isPrimary) ?? signatories[0] ?? null;

    const [companyLogoBuffer, signatureBuffer] = await Promise.all([
      organization.companyLogoUrl
        ? readStoredFile(organization.companyLogoUrl).catch(() => null)
        : Promise.resolve(null),
      primarySignatory?.signatureUrl
        ? readStoredFile(primarySignatory.signatureUrl).catch(() => null)
        : Promise.resolve(null),
    ]);

    const buffer = await this.pdfService.render({
      content: { title, paragraphs },
      documentNumber,
      issueDate: new Date(),
      companyName,
      companyAddress: organization.registeredAddress || '',
      companyLogoBuffer,
      addressedToEmployee: template.addressedToEmployee,
      employeeName: employee.name,
      employeeIdLabel: `Employee ID: ${employee.employeeId}`,
      signatoryName: primarySignatory?.name || null,
      signatoryDesignation: primarySignatory?.designation || null,
      signatureBuffer,
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LETTER_ISSUED',
      module: AuditModule.DOCUMENT,
      organizationId,
      targetId: employeeId,
      details: { key, templateName: template.name, documentNumber },
    });

    return {
      buffer,
      filename: `${key}-${employee.employeeId}.pdf`,
    };
  }

  // HR/Admin-only follow-up to generate() — everything is pulled from the
  // same real employee/org/computed data, nothing to fill in; HR reviews
  // the PDF (via generate()/the Download button), optionally edits the
  // title/body text for this one send (overrides — see SendLetterDto), and
  // this then emails that content to the employee's registered address.
  // Deliberately a second call to generate() rather than threading the
  // caller's already-fetched buffer through: this issues its own document
  // number for the copy that actually goes out, same as any other
  // independent download/generate call — see generate()'s own docstring,
  // numbers were never meant to be contiguous or deduped across repeat
  // generations.
  async send(
    employeeId: string,
    key: string,
    actor: Actor,
    organizationId: string,
    // HR's edited title/body for this one send, if they changed anything in
    // the Send modal — see SendLetterDto and generate()'s own comment.
    overrides?: { title?: string; body?: string },
  ): Promise<{ message: string }> {
    const template = await this.letterTemplatesService.findActiveByKey(
      key,
      organizationId,
    );
    if (!template) {
      throw new BadRequestException(
        `No active letter template found for '${key}' — configure one in Organization Settings > Letter Templates.`,
      );
    }

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
      select: { name: true, email: true },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    if (!employee.email) {
      throw new BadRequestException(
        'This employee has no email address on file to send the letter to.',
      );
    }

    const { buffer, filename } = await this.generate(
      employeeId,
      key,
      actor,
      organizationId,
      overrides,
    );

    const organization = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { companyName: true, registeredAddress: true },
    });
    const companyName = organization?.companyName || 'the Company';

    const rendered = await this.emailTemplatesService.renderOccasion(
      organizationId,
      'LETTER_SENT',
      {
        employeeName: employee.name,
        letterName: template.name,
        companyName,
      },
      {
        subject: `Your ${template.name} from ${companyName}`,
        html: `<p>Hi ${employee.name},</p><p>Please find your ${template.name} attached.</p><p>${companyName}</p>`,
      },
    );

    await this.emailService.send({
      to: employee.email,
      subject: rendered.subject,
      html: rendered.html,
      attachments: [{ filename, content: buffer }],
    });

    const edited = !!(overrides?.title?.trim() || overrides?.body?.trim());
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LETTER_EMAILED',
      module: AuditModule.DOCUMENT,
      organizationId,
      targetId: employeeId,
      details: { key, templateName: template.name, to: employee.email, edited },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId,
      eventKey: 'LETTER_EMAILED',
      performedById: actor.id,
      description: `${template.name} emailed to ${employee.email}.`,
    });

    return { message: `${template.name} emailed to ${employee.email}.` };
  }

  private async latestOffboardingCase(
    employeeId: string,
    organizationId: string,
  ) {
    const offboardingCase = await this.scopedPrisma.offboardingCase.findFirst({
      where: { organizationId, employeeId },
      orderBy: { createdAt: 'desc' },
    });
    if (!offboardingCase) {
      throw new BadRequestException(
        'No offboarding case found for this employee yet — initiate offboarding first.',
      );
    }
    return offboardingCase;
  }
}
