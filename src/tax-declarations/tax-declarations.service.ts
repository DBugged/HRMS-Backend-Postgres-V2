// Purpose: Manages per-employee, per-financial-year tax declarations (regime choice, 80C/80D/etc.
// deductions, HRA/LTA inputs) that PayrollService.calculatePayroll reads for TDS calculation.
// Responsibilities: Owns self-vs-other employeeId resolution (an EMPLOYEE is always forced to their own
// record) and upsert-by-(employee, financialYear).
// Important: upsert()'s isOwnDeclaration check is identity-based, not role-based — an HR/Admin caller
// editing their OWN declaration can never set `status` themselves (closing a self-verification loophole),
// even though they could set it freely when editing someone else's.
import { isMetroCity } from '../common/hra-cities';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  EmployeeTaxDeclaration,
  NotificationCategory,
  Role,
  TaxDeclarationStatus,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { UpsertTaxDeclarationDto } from './dto/upsert-tax-declaration.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { assertManagerDeptScope } from '../common/dept-scope';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { getFinancialYear } from '../payroll-settings/financial-year';

type Actor = Omit<User, 'password'>;

const MONTH_NAMES = [
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

@Injectable()
export class TaxDeclarationsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly emailTemplatesService: EmailTemplatesService,
    private readonly payrollSettingsService: PayrollSettingsService,
  ) {}

  // Org-wide "employee can't see or do anything on Tax Declaration" switch
  // (Organization Settings > General Settings > Payroll & Attendance). Only
  // gates the EMPLOYEE role specifically — an ADMIN/HR/MANAGER caller still
  // reaches their own declaration (they may need to file one too) and can
  // always manage anyone else's regardless of this setting.
  private async assertEnabledForEmployee(
    actor: Actor,
    organizationId: string,
  ): Promise<void> {
    if (actor.role !== Role.EMPLOYEE) return;
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { orgPayrollAttendancePrefs: true },
    });
    const prefs = (org?.orgPayrollAttendancePrefs ?? {}) as {
      enableTaxDeclaration?: boolean;
    };
    if (prefs.enableTaxDeclaration === false) {
      throw new ForbiddenException(
        'Tax Declaration is currently disabled for your organization.',
      );
    }
  }

  async get(
    employeeIdParam: string | undefined,
    financialYear: string | undefined,
    actor: Actor,
    organizationId: string,
  ) {
    await this.assertEnabledForEmployee(actor, organizationId);

    // EMPLOYEE always gets forced to their own record — an employeeId
    // query param must be ignored for that role, or they could view a
    // co-worker's declaration just by guessing/passing another id. Every
    // other role defaults to their own record when no employeeId is given
    // (this is what lets ADMIN/HR/MANAGER use the self-service "my
    // declaration" page, which never sends employeeId, same as EMPLOYEE
    // does) but can still pass one explicitly to view someone else's.
    const employeeId =
      actor.role === Role.EMPLOYEE ? actor.id : (employeeIdParam ?? actor.id);
    if (!employeeId || !financialYear) {
      throw new BadRequestException(
        'employeeId and financialYear are required.',
      );
    }
    await this.assertEmployeeInOrg(employeeId, organizationId);
    if (employeeId !== actor.id) {
      await assertManagerDeptScope(
        this.scopedPrisma,
        actor,
        organizationId,
        employeeId,
      );
    }

    const declaration =
      await this.scopedPrisma.employeeTaxDeclaration.findFirst({
        where: { organizationId, employeeId, financialYear },
      });
    return { declaration };
  }

  private async assertEmployeeInOrg(
    employeeId: string,
    organizationId: string,
  ) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
  }

  async upsert(
    dto: UpsertTaxDeclarationDto,
    actor: Actor,
    organizationId: string,
  ) {
    await this.assertEnabledForEmployee(actor, organizationId);

    // Same self-resolution as get() above, including the same EMPLOYEE
    // guard — an EMPLOYEE must never be able to write another employee's
    // declaration by passing dto.employeeId.
    const employeeId =
      actor.role === Role.EMPLOYEE ? actor.id : (dto.employeeId ?? actor.id);

    // Identity-based, not role-based — closes the gap where an HR/Admin
    // editing their OWN record could self-verify. Any caller editing
    // someone else's declaration may set status; editing your own never
    // can, regardless of your role.
    const isOwnDeclaration = employeeId === actor.id;
    // Writing someone else's declaration (marking it VERIFIED, setting Section 89 relief, correcting figures) is an
    // HR/Admin job - a manager may read their department's declarations but never change one.
    if (
      !isOwnDeclaration &&
      actor.role !== Role.ADMIN &&
      actor.role !== Role.HR
    ) {
      throw new ForbiddenException(
        "Only HR or an Admin can change another employee's tax declaration.",
      );
    }
    // Investment figures (80C, HRA, regime, other income, ...) are the employee's own declaration: HR/Admin see them
    // read-only. What they may still do on someone else's record is the HR work - set the status (verify / reopen)
    // and Section 89 relief (from the Form 10E they computed).
    if (!isOwnDeclaration) {
      const HR_ONLY_KEYS = new Set([
        'employeeId',
        'financialYear',
        'status',
        'section89Relief',
      ]);
      const touched = Object.entries(dto as unknown as Record<string, unknown>)
        .filter(([k, v]) => v !== undefined && !HR_ONLY_KEYS.has(k))
        .map(([k]) => k);
      if (touched.length > 0) {
        throw new ForbiddenException(
          "An employee's investment declaration is view-only for HR and Admin - the employee enters it themselves. You can verify it or set Section 89 relief.",
        );
      }
    }
    if (!isOwnDeclaration) {
      await assertManagerDeptScope(
        this.scopedPrisma,
        actor,
        organizationId,
        employeeId,
      );
    }

    // The target must be an employee of THIS organisation — without it an Admin of another tenant could create a
    // declaration (and timeline entries) pointing at someone else's employee id.
    await this.assertEmployeeInOrg(employeeId, organizationId);

    const existing = await this.scopedPrisma.employeeTaxDeclaration.findFirst({
      where: { organizationId, employeeId, financialYear: dto.financialYear },
    });

    // Tax a previous employer deducted cannot be more than the income it paid - without this check a typo (or a
    // deliberate inflated figure) is credited against this year's tax and the employee's TDS drops too low.
    if (
      dto.previousEmployerIncome !== undefined ||
      dto.previousEmployerTDS !== undefined
    ) {
      const income =
        dto.previousEmployerIncome ?? existing?.previousEmployerIncome ?? 0;
      const tds = dto.previousEmployerTDS ?? existing?.previousEmployerTDS ?? 0;
      if (tds > income) {
        throw new BadRequestException(
          `Tax deducted by the previous employer (${tds}) cannot be more than the income paid by it (${income}).`,
        );
      }
    }

    if (isOwnDeclaration) {
      // Locked once submitted — the whole point of "submit" is that it's
      // final; further self-edits (including re-submitting) are rejected
      // outright. HR/Admin can still reopen it by setting status back to
      // DRAFT via their own (non-own-declaration) edit path below.
      if (existing && existing.status !== TaxDeclarationStatus.DRAFT) {
        throw new BadRequestException(
          `Your declaration for FY ${dto.financialYear} has already been submitted and can no longer be changed.`,
        );
      }

      // "Next FY opens in April" — an employee can't start/edit a
      // declaration for a financial year that hasn't begun yet under the
      // org's own financialYearStartMonth (April by default). Only gates
      // own-declaration writes; HR/Admin editing on someone's behalf keeps
      // the flexibility to process things early if genuinely needed.
      const settings =
        await this.payrollSettingsService.getOrCreate(organizationId);
      const today = new Date();
      const currentFinancialYear = getFinancialYear(
        today.getMonth() + 1,
        today.getFullYear(),
        settings.financialYearStartMonth,
      );
      if (dto.financialYear > currentFinancialYear) {
        throw new BadRequestException(
          `FY ${dto.financialYear} hasn't started yet — it opens for declarations in ${MONTH_NAMES[settings.financialYearStartMonth]}.`,
        );
      }
    }

    // The one status transition an employee can make on their own
    // declaration — DRAFT -> SUBMITTED via `submit`, never any other value
    // (that's still `dto.status`, still stripped for isOwnDeclaration).
    const status = isOwnDeclaration
      ? dto.submit
        ? TaxDeclarationStatus.SUBMITTED
        : undefined
      : dto.status;

    const data = {
      ...(dto.regimeChosen !== undefined && { regimeChosen: dto.regimeChosen }),
      ...(dto.section80C !== undefined && { section80C: dto.section80C }),
      ...(dto.section80CCD1B !== undefined && {
        section80CCD1B: dto.section80CCD1B,
      }),
      ...(dto.section80CCD2 !== undefined && {
        section80CCD2: dto.section80CCD2,
      }),
      ...(dto.section80D !== undefined && { section80D: dto.section80D }),
      ...(dto.section80E !== undefined && { section80E: dto.section80E }),
      ...(dto.section80G !== undefined && { section80G: dto.section80G }),
      ...(dto.otherDeductions !== undefined && {
        otherDeductions: dto.otherDeductions,
      }),
      ...(dto.hraRentPaidAnnual !== undefined && {
        hraRentPaidAnnual: dto.hraRentPaidAnnual,
      }),
      // A chosen city decides "metro"; the bare flag is only honoured from older clients that do not send a city.
      ...(dto.hraCity !== undefined
        ? {
            hraCity: dto.hraCity,
            isMetroCity: isMetroCity(dto.hraCity, dto.financialYear),
          }
        : dto.isMetroCity !== undefined
          ? // A bare flag says nothing about which city, so a previously chosen city is cleared rather than left
            // contradicting it.
            { isMetroCity: dto.isMetroCity, hraCity: '' }
          : {}),
      ...(dto.ltaClaimed !== undefined && { ltaClaimed: dto.ltaClaimed }),
      ...(dto.previousEmployerIncome !== undefined && {
        previousEmployerIncome: dto.previousEmployerIncome,
      }),
      ...(dto.previousEmployerTDS !== undefined && {
        previousEmployerTDS: dto.previousEmployerTDS,
      }),
      ...(dto.otherIncome !== undefined && { otherIncome: dto.otherIncome }),
      ...(dto.homeLoanInterest !== undefined && {
        homeLoanInterest: dto.homeLoanInterest,
      }),
      ...(dto.section80TTA !== undefined && { section80TTA: dto.section80TTA }),
      // Relief u/s 89 reduces the employee's tax — only HR/Admin (acting on someone else's declaration, from the
      // Form 10E they computed) may set it.
      ...(!isOwnDeclaration &&
        dto.section89Relief !== undefined && {
          section89Relief: dto.section89Relief,
        }),
      ...(status !== undefined && { status }),
    };

    let declaration: EmployeeTaxDeclaration;
    if (existing) {
      await this.scopedPrisma.employeeTaxDeclaration.updateMany({
        where: { id: existing.id, organizationId },
        data,
      });
      declaration =
        await this.scopedPrisma.employeeTaxDeclaration.findFirstOrThrow({
          where: { id: existing.id, organizationId },
        });
    } else {
      declaration = await this.scopedPrisma.employeeTaxDeclaration.create({
        data: {
          organizationId,
          employeeId,
          financialYear: dto.financialYear,
          ...data,
        },
      });
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: existing ? 'TAX_DECLARATION_UPDATED' : 'TAX_DECLARATION_CREATED',
      module: 'PAYROLL',
      organizationId,
      targetId: declaration.id,
      details: {
        employeeId,
        financialYear: dto.financialYear,
        status,
        // What actually changed (old -> new): regime, amounts and status all move TDS, so an auditor must be able
        // to see who changed which figure.
        changes: existing
          ? Object.fromEntries(
              Object.keys(data)
                .filter(
                  (k) =>
                    (existing as Record<string, unknown>)[k] !==
                    (declaration as Record<string, unknown>)[k],
                )
                .map((k) => [
                  k,
                  {
                    from: (existing as Record<string, unknown>)[k],
                    to: (declaration as Record<string, unknown>)[k],
                  },
                ]),
            )
          : undefined,
      },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId,
      eventKey: 'TAX_DECLARATION_UPDATED',
      performedById: actor.id,
      description: `Tax declaration for FY ${dto.financialYear} ${existing ? 'updated' : 'created'}.`,
    });

    if (!isOwnDeclaration && status === TaxDeclarationStatus.VERIFIED) {
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: employeeId, organizationId },
      });
      if (employee) {
        const title = 'Tax Declaration Verified';
        const message = `Your tax declaration for FY ${dto.financialYear} has been verified.`;
        await this.notificationsService.create({
          organizationId,
          userId: employee.id,
          title,
          message,
          category: NotificationCategory.GENERAL,
        });
        const rendered = await this.emailTemplatesService.renderOccasion(
          organizationId,
          'TAX_DECLARATION_VERIFIED',
          { employeeName: employee.name, financialYear: dto.financialYear },
          { subject: title, html: message },
        );
        // Fire-and-forget — the verification has already committed.
        void this.emailService.send({
          organizationId,
          to: employee.email,
          subject: rendered.subject,
          html: rendered.html,
        });
      }
    }

    return declaration;
  }
}
