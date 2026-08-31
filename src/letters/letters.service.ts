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
  ) {}

  async generate(
    employeeId: string,
    key: string,
    actor: Actor,
    organizationId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
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
    };

    switch (template.dataProfile) {
      case LetterDataProfile.EXIT: {
        const lastWorkingDay = await this.latestLastWorkingDay(
          employeeId,
          organizationId,
        );
        variables.lastWorkingDay = formatDateDisplay(lastWorkingDay);
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
        variables.lastWorkingDay = formatDateDisplay(
          settlement.lastWorkingDay,
        );
        variables.pendingSalary = money(settlement.pendingSalaryAmount);
        variables.leaveEncashment = money(settlement.leaveEncashmentAmount);
        variables.bonus = money(settlement.bonusAmount);
        variables.gratuity = money(settlement.gratuityAmount);
        variables.recoveries = money(settlement.recoveriesAmount);
        variables.loanRecovered = money(settlement.loanBalanceRecovered);
        variables.noticePeriodRecovery = money(
          settlement.noticePeriodRecovery,
        );
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

    const title = this.letterTemplatesService.render(
      template.title,
      variables,
    );
    const renderedBody = this.letterTemplatesService.render(
      template.bodyText,
      variables,
    );
    const paragraphs = renderedBody
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

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

  private async latestLastWorkingDay(
    employeeId: string,
    organizationId: string,
  ): Promise<string> {
    const offboardingCase = await this.scopedPrisma.offboardingCase.findFirst(
      {
        where: { organizationId, employeeId },
        orderBy: { createdAt: 'desc' },
      },
    );
    if (!offboardingCase) {
      throw new BadRequestException(
        'No offboarding case found for this employee yet — initiate offboarding first.',
      );
    }
    return offboardingCase.lastWorkingDay;
  }
}
