// Purpose: Orchestrates the 7 letter types — fetches the real employee/org/computed data each needs,
//   issues the org's configured document number for it (making Document Numbering's Offer Letter/
//   Appointment Letter/Relieving Letter/Experience Letter/Experience Certificate/Salary Certificate/
//   Full & Final Settlement entries actually get used, the same way employeeId/payslip already are), and
//   renders the PDF.
// Important: view-scoped the same way EmployeeTimelineService is — self, or ADMIN/HR see anyone, MANAGER
//   only their own department (enforced here; the self-or-role split itself is the controller's guard).
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditModule, PayrollRunStatus, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { readStoredFile } from '../files/file-storage.config';
import { issueDocumentNumber } from '../organizations/document-numbering';
import { LetterPdfService } from './letter-pdf.service';
import { isLetterType, type LetterType } from './letter-types';
import {
  offerLetterContent,
  appointmentLetterContent,
  relievingLetterContent,
  experienceLetterContent,
  experienceCertificateContent,
  salaryCertificateContent,
  fullFinalSettlementContent,
  type LetterEmployeeInfo,
  type LetterContent,
} from './letter-content';

type Actor = Omit<User, 'password'>;

// Offer/Appointment/Relieving/FnF read as "Dear <employee>," letters
// (addressed to the employee); Experience Letter/Certificate and Salary
// Certificate read as "This is to certify..." documents (generic, carried
// by the employee to a third party) — see LetterPdfInput.addressedToEmployee.
const ADDRESSED_TO_EMPLOYEE = new Set<LetterType>([
  'offerLetter',
  'appointmentLetter',
  'relievingLetter',
  'fullFinalSettlement',
]);

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
  ) {}

  async generate(
    employeeId: string,
    letterType: string,
    actor: Actor,
    organizationId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    if (!isLetterType(letterType)) {
      throw new BadRequestException(`Unknown letter type: ${letterType}`);
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
    // fonts (including the Roboto subset embedded here) don't reliably
    // carry the ₹ glyph, so a non-ASCII configured symbol renders as a
    // broken glyph — fall back to "Rs." rather than let that happen (the
    // web UI elsewhere still renders ₹ fine via the browser's own font).
    // eslint-disable-next-line no-control-regex -- ASCII-only check, not a stray control char
    const currencySymbol = /^[\x00-\x7F]+$/.test(rawSymbol) ? rawSymbol : 'Rs.';

    const employeeInfo: LetterEmployeeInfo = {
      name: employee.name,
      employeeId: employee.employeeId,
      designation: employee.designation,
      departmentName: employee.department?.name ?? null,
      employeeType: employee.employeeType,
      joiningDate: employee.joiningDate,
    };

    const content = await this.buildContent(
      letterType,
      employeeInfo,
      companyName,
      currencySymbol,
      employeeId,
      organizationId,
    );

    const documentNumber = await this.scopedPrisma.$transaction((tx) =>
      issueDocumentNumber(tx, organizationId, letterType),
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
      content,
      documentNumber,
      issueDate: new Date(),
      companyName,
      companyAddress: organization.registeredAddress || '',
      companyLogoBuffer,
      addressedToEmployee: ADDRESSED_TO_EMPLOYEE.has(letterType),
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
      details: { letterType, documentNumber },
    });

    return {
      buffer,
      filename: `${letterType}-${employee.employeeId}.pdf`,
    };
  }

  private async buildContent(
    letterType: LetterType,
    employeeInfo: LetterEmployeeInfo,
    companyName: string,
    currencySymbol: string,
    employeeId: string,
    organizationId: string,
  ): Promise<LetterContent> {
    switch (letterType) {
      case 'offerLetter':
        return offerLetterContent(employeeInfo, companyName);
      case 'appointmentLetter':
        return appointmentLetterContent(employeeInfo, companyName);
      case 'relievingLetter': {
        const lastWorkingDay = await this.latestLastWorkingDay(
          employeeId,
          organizationId,
        );
        return relievingLetterContent(
          employeeInfo,
          companyName,
          lastWorkingDay,
        );
      }
      case 'experienceLetter': {
        const lastWorkingDay = await this.latestLastWorkingDay(
          employeeId,
          organizationId,
        );
        return experienceLetterContent(
          employeeInfo,
          companyName,
          lastWorkingDay,
        );
      }
      case 'experienceCertificate': {
        const lastWorkingDay = await this.latestLastWorkingDay(
          employeeId,
          organizationId,
        );
        return experienceCertificateContent(
          employeeInfo,
          companyName,
          lastWorkingDay,
        );
      }
      case 'salaryCertificate': {
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
            'No processed payroll run found for this employee yet — a Salary Certificate needs at least one.',
          );
        }
        return salaryCertificateContent(
          employeeInfo,
          companyName,
          {
            month: run.month,
            year: run.year,
            grossSalary: run.grossSalary,
            netPay: run.netPay,
            ctcMonthly: run.ctcMonthly,
          },
          currencySymbol,
        );
      }
      case 'fullFinalSettlement': {
        const settlement = await this.scopedPrisma.settlement.findFirst({
          where: { organizationId, employeeId },
          orderBy: { createdAt: 'desc' },
        });
        if (!settlement) {
          throw new BadRequestException(
            'No settlement found for this employee yet — calculate one first (Offboarding > Full & Final Settlement).',
          );
        }
        return fullFinalSettlementContent(
          employeeInfo,
          companyName,
          settlement,
          currencySymbol,
        );
      }
    }
  }

  private async latestLastWorkingDay(
    employeeId: string,
    organizationId: string,
  ): Promise<string> {
    const offboardingCase = await this.scopedPrisma.offboardingCase.findFirst({
      where: { organizationId, employeeId },
      orderBy: { createdAt: 'desc' },
    });
    if (!offboardingCase) {
      throw new BadRequestException(
        'No offboarding case found for this employee yet — initiate offboarding first.',
      );
    }
    return offboardingCase.lastWorkingDay;
  }
}
