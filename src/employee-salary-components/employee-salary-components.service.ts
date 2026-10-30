// Purpose: Manages an employee's individual salary-component structure as a revision history over time.
// Responsibilities: Owns applyRevision() (close-out-then-insert, never mutates an existing row's value
// fields) shared by setComponentValue and bulkSetStructure; exposes getCurrentMonthlyValue() for other
// modules (e.g. Leave Encashment) to resolve one component's live monthly value without a full payroll run.
// Important: getCurrentMonthlyValue() resolves formula/percentage dependencies recursively via
// extractDependencies/resolveComponentValue, so component definitions can reference each other by code.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EmployeeSalaryComponent,
  NotificationCategory,
  PayrollRunStatus,
  Prisma,
  SalaryComponent,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { SetComponentValueDto } from './dto/set-component-value.dto';
import { BulkSetStructureDto } from './dto/bulk-set-structure.dto';
import {
  dayBefore,
  localDateStr,
  resolveCurrentRows,
  summarizeStructure,
  synthesizeMissingRows,
} from './salary-structure-math';
import { effectiveWorkLocation } from '../common/effective-work-location';
import { employeeCityClass, withCityHra } from './city-hra';
import { defaultHraPercent } from '../common/hra-cities';
import {
  extractDependencies,
  resolveComponentValue,
} from './component-value-resolution';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { SalaryStructurePdfService } from './salary-structure-pdf.service';

import { dmyText } from '../payroll/format-date';
// A stored effective date as YYYY-MM-DD, whether the column hands back a string or a Date.
const dateOnly = (v: Date | string): string =>
  typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);

@Injectable()
export class EmployeeSalaryComponentsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly emailTemplatesService: EmailTemplatesService,
    private readonly salaryStructurePdf: SalaryStructurePdfService,
  ) {}

  // Tells the employee their salary structure was revised: an in-app notification (and phone push), and an email with
  // their Salary Structure document attached - the document carries the details, so the email itself states no
  // amounts and none are put in the notification. Skipped when the person revised their own salary (an Admin can) or when the
  // organisation switched it off (orgPayrollAttendancePrefs.notifySalaryRevision === false). Best-effort: the revision
  // is already saved, so a problem here (no active letter template, no email on file...) is swallowed and never
  // fails the caller.
  private async notifyRevision(
    employeeId: string,
    actorId: string,
    organizationId: string,
    effectiveFrom: string,
  ): Promise<void> {
    try {
      if (employeeId === actorId) return;
      const [org, employee] = await Promise.all([
        this.scopedPrisma.organization.findFirst({
          where: { id: organizationId },
          select: { orgPayrollAttendancePrefs: true },
        }),
        this.scopedPrisma.user.findFirst({
          where: { id: employeeId, organizationId },
          select: { isActive: true },
        }),
      ]);
      const prefs = (org?.orgPayrollAttendancePrefs ?? {}) as {
        notifySalaryRevision?: boolean;
      };
      if (prefs.notifySalaryRevision === false) return;
      if (!employee || !employee.isActive) return;

      const [y, m, d] = effectiveFrom.slice(0, 10).split('-');
      const effective = y && m && d ? `${d}-${m}-${y}` : effectiveFrom;
      await this.notificationsService.create({
        organizationId,
        userId: employeeId,
        title: 'Salary structure revised',
        message: `Your salary structure was revised, effective ${effective}. Your updated Salary Structure has been emailed to you; open My Salary Structure to see the details.`,
        category: NotificationCategory.PAYROLL,
      });
    } catch {
      // best-effort notice - the revision itself has already been saved
    }
    try {
      if (employeeId === actorId) return;
      const [org, employee] = await Promise.all([
        this.scopedPrisma.organization.findFirst({
          where: { id: organizationId },
          select: { orgPayrollAttendancePrefs: true },
        }),
        this.scopedPrisma.user.findFirst({
          where: { id: employeeId, organizationId },
          select: { name: true, email: true, isActive: true, brandId: true },
        }),
      ]);
      const prefs = (org?.orgPayrollAttendancePrefs ?? {}) as {
        notifySalaryRevision?: boolean;
      };
      if (prefs.notifySalaryRevision === false) return;
      if (!employee?.email || !employee.isActive) return;

      // The Salary Structure document as of the revision's effective date.
      const { buffer, filename } = await this.salaryStructurePdf.build(
        employeeId,
        organizationId,
        effectiveFrom,
      );
      const [y, m, d] = effectiveFrom.slice(0, 10).split('-');
      const variables = {
        employeeName: employee.name,
        effectiveFrom: y && m && d ? `${d}-${m}-${y}` : effectiveFrom,
      };
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'SALARY_REVISED',
        variables,
        this.emailTemplatesService.defaultFor('SALARY_REVISED', variables),
        { brandId: employee.brandId },
      );
      await this.emailService.send({
        organizationId,
        to: employee.email,
        subject: rendered.subject,
        html: rendered.html,
        attachments: [{ filename, content: buffer }],
      });
    } catch {
      // no structure to show, no email on file - nothing to send
    }
  }

  private async getOrgTimezone(organizationId: string): Promise<string> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone ?? 'Asia/Kolkata';
  }

  // One line per active employee for the directory: is a salary set up, and what is the CTC. HRA that has no line of its
  // own follows the work location, the same as everywhere else (see city-hra.ts).
  async listSalarySummaries(organizationId: string) {
    const asOf = localDateStr(await this.getOrgTimezone(organizationId));
    const [users, rows, components] = await Promise.all([
      this.scopedPrisma.user.findMany({
        where: { organizationId, isActive: true },
        select: {
          id: true,
          workLocation: { select: { cityClass: true } },
          department: {
            select: { workLocation: { select: { cityClass: true } } },
          },
        },
      }),
      this.scopedPrisma.employeeSalaryComponent.findMany({
        where: { organizationId },
        include: {
          component: {
            select: {
              id: true,
              code: true,
              name: true,
              type: true,
              calcType: true,
              payFrequency: true,
              isEmployerContribution: true,
              displayOrder: true,
            },
          },
        },
      }),
      this.scopedPrisma.salaryComponent.findMany({
        where: { organizationId, isActive: true },
      }),
    ]);
    const rowsByEmployee = new Map<string, typeof rows>();
    for (const r of rows) {
      rowsByEmployee.set(r.employeeId, [
        ...(rowsByEmployee.get(r.employeeId) ?? []),
        r,
      ]);
    }
    return users.map((u) => {
      const own = (rowsByEmployee.get(u.id) ?? []).map((r) => ({
        ...r,
        componentRef: r.component,
      }));
      const current = resolveCurrentRows(own, asOf);
      if (!current.some((r) => r.isEnabled)) {
        return {
          employeeId: u.id,
          hasStructure: false,
          annualCtc: 0,
          fixedMonthly: 0,
          variableAnnual: 0,
        };
      }
      const cityClass = effectiveWorkLocation(u)?.cityClass ?? 'NON_METRO';
      const synthesized = synthesizeMissingRows(
        own,
        withCityHra(components, cityClass),
        asOf,
      );
      const summary = summarizeStructure([...current, ...synthesized]);
      return {
        employeeId: u.id,
        hasStructure: true,
        annualCtc: summary.annualCTC,
        fixedMonthly: summary.fixedMonthly,
        // Yearly lines whether labelled variable or one-time: both are paid on top of the monthly fixed pay.
        variableAnnual: summary.variableAnnual + summary.oneTimeAnnual,
      };
    });
  }

  async getStructure(
    employeeId: string,
    asOfParam: string | undefined,
    organizationId: string,
  ) {
    await this.assertEmployeeExists(employeeId, organizationId);
    const asOf =
      asOfParam ?? localDateStr(await this.getOrgTimezone(organizationId));

    const [rawRows, activeComponents] = await Promise.all([
      this.scopedPrisma.employeeSalaryComponent.findMany({
        where: { organizationId, employeeId },
        // Every field the frontend's buildBreakdown (EmployeeFullProfile.tsx)
        // actually reads off `componentRef` — type (is this even an
        // earning?), payFrequency (is this recurring-monthly vs
        // yearly/half-yearly/quarterly variable pay?), isEmployerContribution
        // (exclude from the employee-facing Earnings total), name. Missing
        // any of these silently mis-buckets the row: previously this only
        // selected {id, displayOrder}, so payFrequency always fell back to
        // 'MONTHLY' client-side and a YEARLY MANUAL component (e.g.
        // "Variable Pay") got summed straight into the monthly Fixed CTC
        // instead of routed to the Variable Pay bucket — see the "wrong
        // Monthly Amount" bug this fixes.
        include: {
          component: {
            select: {
              id: true,
              code: true,
              name: true,
              type: true,
              calcType: true,
              payFrequency: true,
              isEmployerContribution: true,
              displayOrder: true,
            },
          },
        },
      }),
      this.scopedPrisma.salaryComponent.findMany({
        where: { organizationId, isActive: true },
      }),
    ]);
    // Renamed here (not at the Prisma layer, which can only ever be called
    // `component` — it's the relation name) to match what buildBreakdown
    // reads on every row: `r.componentRef`.
    const rows = rawRows.map((r) => ({ ...r, componentRef: r.component }));

    const current = resolveCurrentRows(rows, asOf);
    const cityClass = await employeeCityClass(
      this.scopedPrisma,
      employeeId,
      organizationId,
    );
    const synthesized = synthesizeMissingRows(
      rows,
      withCityHra(activeComponents, cityClass),
      asOf,
    );

    const displayOrderByCode = new Map(
      activeComponents.map((c) => [c.code, c.displayOrder]),
    );
    const structure = [...current, ...synthesized].sort(
      (a, b) =>
        (displayOrderByCode.get(a.componentCode) ?? 0) -
        (displayOrderByCode.get(b.componentCode) ?? 0),
    );

    // The HRA percentage of Basic that applies to this employee's city class - lets the revision history, which
    // rebuilds past batches in the browser, fill in HRA the same way.
    return { structure, hraDefaultPercent: defaultHraPercent(cityClass) };
  }

  async getHistory(
    employeeId: string,
    componentCode: string | undefined,
    organizationId: string,
  ) {
    await this.assertEmployeeExists(employeeId, organizationId);
    // Feeds the same frontend buildBreakdown() as getStructure — needs the
    // same full componentRef shape (see getStructure's comment) so a
    // historical Variable Pay/etc. row reconstructs into the right bucket
    // too, not just the current structure.
    const rows = await this.scopedPrisma.employeeSalaryComponent.findMany({
      where: {
        organizationId,
        employeeId,
        ...(componentCode && { componentCode }),
      },
      include: {
        component: {
          select: {
            id: true,
            code: true,
            name: true,
            type: true,
            calcType: true,
            payFrequency: true,
            isEmployerContribution: true,
            displayOrder: true,
          },
        },
      },
      orderBy: [{ componentCode: 'asc' }, { effectiveFrom: 'desc' }],
    });
    return rows.map((r) => ({ ...r, componentRef: r.component }));
  }

  async setComponentValue(
    employeeId: string,
    dto: SetComponentValueDto,
    actorId: string,
    organizationId: string,
  ): Promise<EmployeeSalaryComponent> {
    await this.assertEmployeeExists(employeeId, organizationId);
    const component = await this.resolveComponentOrThrow(dto, organizationId);
    const row = await this.applyRevision(
      employeeId,
      component,
      dto,
      actorId,
      organizationId,
    );
    void this.notifyRevision(
      employeeId,
      actorId,
      organizationId,
      dateOnly(row.effectiveFrom),
    );
    return row;
  }

  async bulkSetStructure(
    employeeId: string,
    dto: BulkSetStructureDto,
    actorId: string,
    organizationId: string,
  ) {
    await this.assertEmployeeExists(employeeId, organizationId);
    // Whether this is the employee's first salary structure (checked before anything is saved; see the warning below).
    const hadStructure =
      (await this.scopedPrisma.employeeSalaryComponent.count({
        where: { organizationId, employeeId },
      })) > 0;
    const created: EmployeeSalaryComponent[] = [];
    // Matches the fail-but-continue + per-row `failed` report convention
    // used by HolidaysService.bulkImport: an unrecognized componentId/code
    // used to be silently dropped (original release's "fault tolerance"), which
    // left the caller seeing a lower `count` than `lines.length` with no
    // indication why. Now every unresolved line is reported by name/index
    // instead of vanishing silently, while still not aborting the whole
    // batch over one bad line.
    const failed: {
      row: number;
      componentId?: string;
      componentCode?: string;
      error: string;
    }[] = [];

    for (const [i, line] of dto.lines.entries()) {
      const component = await this.resolveComponent(line, organizationId);
      if (!component) {
        failed.push({
          row: i + 1,
          componentId: line.componentId,
          componentCode: line.componentCode,
          error: line.componentId
            ? `Salary component not found: ${line.componentId}`
            : line.componentCode
              ? `Salary component not found: ${line.componentCode}`
              : 'Either componentId or componentCode is required',
        });
        continue;
      }
      try {
        const row = await this.applyRevision(
          employeeId,
          component,
          {
            ...line,
            effectiveFrom: dto.effectiveFrom,
            backdateForArrears:
              line.backdateForArrears ?? dto.backdateForArrears,
          },
          actorId,
          organizationId,
        );
        created.push(row);
      } catch (err) {
        // A revision rejected by the effectiveFrom guard is reported per row, like an unresolved component.
        if (!(err instanceof BadRequestException)) throw err;
        failed.push({
          row: i + 1,
          componentId: line.componentId,
          componentCode: line.componentCode,
          error: err.message,
        });
      }
    }

    // Every line refused: say so as an error (the caller used to get HTTP 201 and show "saved" for a change that
    // never happened). A partial success still returns the per-row `failed` report.
    if (created.length === 0 && failed.length > 0) {
      throw new BadRequestException(
        failed
          .map((f) => `${f.componentCode ?? 'row ' + f.row}: ${f.error}`)
          .join(' | '),
      );
    }

    // One notice for the whole revision, not one per line.
    if (created.length > 0) {
      void this.notifyRevision(
        employeeId,
        actorId,
        organizationId,
        dto.effectiveFrom ?? dateOnly(created[0].effectiveFrom),
      );
    }

    const warnings: string[] = [];
    if (created.length > 0) {
      const warning = await this.basicShareWarning(
        employeeId,
        dto.effectiveFrom,
        organizationId,
      );
      if (warning) warnings.push(warning);
    }
    // A first structure that starts after the joining date leaves the months in between with no salary: payroll for
    // them cannot be run. Fine when those months were paid outside the system (opening balances), so only a warning.
    if (created.length > 0 && !hadStructure && dto.effectiveFrom) {
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: employeeId, organizationId },
        select: { joiningDate: true },
      });
      const joined = employee?.joiningDate
        ? dateOnly(employee.joiningDate)
        : null;
      if (joined && dto.effectiveFrom > joined) {
        warnings.push(
          `The salary starts on ${dmyText(dto.effectiveFrom)}, after the joining date ${dmyText(joined)}: there is no salary for the days in between, so payroll cannot be run for them. If that is not meant, revise it again with ${dmyText(joined)} as the effective date.`,
        );
      }
    }

    return { count: created.length, rows: created, failed, warnings };
  }

  // The new Labour Code wants Basic + DA to be at least half of the total monthly pay. This never blocks a save (a
  // structure can be half-built while HR is still entering lines); it tells HR when the saved structure is below it.
  private async basicShareWarning(
    employeeId: string,
    asOfParam: string | undefined,
    organizationId: string,
  ): Promise<string | null> {
    const asOf =
      asOfParam ?? localDateStr(await this.getOrgTimezone(organizationId));
    const share = await this.basicShareFigures(
      employeeId,
      asOf,
      organizationId,
    );
    if (!share || share.belowHalf === false) return null;
    return `Basic + DA is ${share.percent}% of the monthly pay (₹${Math.round(share.wages)} of ₹${Math.round(share.gross)}). Under the new Labour Code it should be at least 50%, otherwise PF and gratuity are worked out on a higher wage than the structure shows.`;
  }

  // Basic + DA against the recurring monthly pay (yearly variable pay, one-month entries and overtime are not part of it).
  // null when there is no monthly pay at all.
  private async basicShareFigures(
    employeeId: string,
    asOf: string,
    organizationId: string,
  ): Promise<{
    gross: number;
    wages: number;
    percent: number;
    belowHalf: boolean;
  } | null> {
    const { structure } = await this.getStructure(
      employeeId,
      asOf,
      organizationId,
    );
    const monthlyEarnings = structure.filter((r) => {
      const ref = r.componentRef as
        | {
            type: string;
            isEmployerContribution?: boolean;
            payFrequency?: string;
          }
        | null
        | undefined;
      return (
        ref &&
        ref.type === 'EARNING' &&
        !ref.isEmployerContribution &&
        ref.payFrequency === 'MONTHLY' &&
        r.isEnabled !== false &&
        !('applyOnlyForMonth' in r && r.applyOnlyForMonth) &&
        r.componentCode !== 'OVERTIME_PAY'
      );
    });
    let gross = 0;
    let wages = 0;
    for (const r of monthlyEarnings) {
      const value = await this.getCurrentMonthlyValue(
        employeeId,
        r.componentCode,
        asOf,
        organizationId,
      );
      gross += value;
      if (r.componentCode === 'BASIC' || r.componentCode === 'DA') {
        wages += value;
      }
    }
    if (gross <= 0) return null;
    return {
      gross,
      wages,
      percent: Math.round((wages / gross) * 1000) / 10,
      belowHalf: wages * 2 < gross - 0.005,
    };
  }

  // Every active employee on the payroll whose Basic + DA is under half of the monthly pay, for the Payroll screen and
  // for HR to correct before the Labour Code rule bites on PF and gratuity.
  async listBelowHalfBasic(organizationId: string) {
    const asOf = localDateStr(await this.getOrgTimezone(organizationId));
    const employees = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true, excludeFromPayroll: false },
      select: { id: true, name: true, employeeId: true },
      orderBy: { name: 'asc' },
    });
    const rows: {
      id: string;
      name: string;
      employeeId: string | null;
      gross: number;
      wages: number;
      percent: number;
    }[] = [];
    for (const e of employees) {
      const share = await this.basicShareFigures(e.id, asOf, organizationId);
      if (share?.belowHalf) {
        rows.push({
          id: e.id,
          name: e.name,
          employeeId: e.employeeId,
          gross: Math.round(share.gross),
          wages: Math.round(share.wages),
          percent: share.percent,
        });
      }
    }
    return { asOf, total: employees.length, employees: rows };
  }

  // Shared revision logic — close out the current open row (effectiveTo
  // only, never mutating value fields), then insert a brand-new row. Used
  // by both setComponentValue and bulkSetStructure so the two entry
  // points can't drift apart (the original release duplicated this inline in
  // both controllers).
  private async applyRevision(
    employeeId: string,
    component: SalaryComponent,
    dto: SetComponentValueDto,
    actorId: string,
    organizationId: string,
  ): Promise<EmployeeSalaryComponent> {
    // A one-month entry (arrears, bonus, incentive) covers exactly that calendar month.
    const onlyMonth = dto.applyOnlyForMonth;
    const monthStart = onlyMonth ? `${onlyMonth}-01` : undefined;
    const monthEnd = onlyMonth
      ? `${onlyMonth}-${String(
          new Date(
            Date.UTC(
              Number(onlyMonth.slice(0, 4)),
              Number(onlyMonth.slice(5, 7)),
              0,
            ),
          ).getUTCDate(),
        ).padStart(2, '0')}`
      : undefined;
    if (
      onlyMonth &&
      dto.effectiveFrom &&
      (dto.effectiveFrom < (monthStart as string) ||
        dto.effectiveFrom > (monthEnd as string))
    ) {
      throw new BadRequestException(
        `effectiveFrom ${dmyText(dto.effectiveFrom)} is outside ${onlyMonth}; leave it out for a one-month entry.`,
      );
    }
    const from =
      dto.effectiveFrom ??
      monthStart ??
      localDateStr(await this.getOrgTimezone(organizationId));

    const current = await this.scopedPrisma.employeeSalaryComponent.findFirst({
      where: {
        organizationId,
        employeeId,
        componentCode: component.code,
        effectiveTo: null,
      },
    });
    if (onlyMonth) {
      if (current) {
        throw new BadRequestException(
          `${component.code} is already a running entry for this employee. Stop or edit that entry instead of adding a one-month one.`,
        );
      }
      if (dto.backdateForArrears !== true) {
        await this.assertNoFinalizedPayrollFrom(
          employeeId,
          from,
          organizationId,
        );
      }
      const values = {
        valueType: dto.valueType ?? component.calcType,
        fixedAmount: dto.fixedAmount ?? null,
        percentageValue: dto.percentageValue ?? null,
        percentageOf: dto.percentageOf ?? null,
        formula: dto.formula ?? null,
        amountBasis: dto.amountBasis ?? 'MONTHLY',
        isEnabled: dto.isEnabled ?? true,
        revisionNote: dto.revisionNote ?? '',
      };
      // The same month entered twice corrects the earlier entry rather than adding a second one.
      const sameMonth =
        await this.scopedPrisma.employeeSalaryComponent.findFirst({
          where: {
            organizationId,
            employeeId,
            componentCode: component.code,
            effectiveFrom: monthStart,
            effectiveTo: monthEnd,
          },
        });
      const saved = sameMonth
        ? await this.scopedPrisma.$transaction(async (tx) => {
            await tx.employeeSalaryComponent.updateMany({
              where: { id: sameMonth.id, organizationId },
              data: values,
            });
            return tx.employeeSalaryComponent.findFirstOrThrow({
              where: { id: sameMonth.id, organizationId },
            });
          })
        : await this.scopedPrisma.employeeSalaryComponent.create({
            data: {
              organizationId,
              employeeId,
              componentId: component.id,
              componentCode: component.code,
              ...values,
              effectiveFrom: monthStart as string,
              effectiveTo: monthEnd as string,
              createdById: actorId,
            },
          });
      await this.auditLogService.log({
        actorId,
        action: 'EMPLOYEE_SALARY_COMPONENT_SET',
        module: 'PAYROLL',
        organizationId,
        targetId: employeeId,
        details: {
          employeeId,
          componentCode: component.code,
          oneMonthOnly: onlyMonth,
          after: {
            ...values,
            effectiveFrom: monthStart,
            effectiveTo: monthEnd,
          },
        },
      });
      return saved;
    }

    // A revision starts after the row it closes out. On the SAME day it corrects that row in place (a salary entered
    // by mistake can be fixed straight away, without waiting a day); a date before it would corrupt the history, so
    // that is refused - except for the very first salary, whose start can be moved earlier (down to the joining date)
    // when it was entered too late and left the first months with none. Either way a month that is already paid is
    // never touched.
    let moveFirstStart = false;
    if (current && from < current.effectiveFrom) {
      const earlier = await this.scopedPrisma.employeeSalaryComponent.count({
        where: {
          organizationId,
          employeeId,
          componentCode: component.code,
          effectiveFrom: { lt: current.effectiveFrom },
        },
      });
      if (earlier > 0) {
        throw new BadRequestException(
          `The new salary cannot start before the current one (${dmyText(current.effectiveFrom)}) for ${component.code}. Use ${dmyText(current.effectiveFrom)} to correct it, or a later date to revise it.`,
        );
      }
      // Moved earlier, but not before they joined.
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: employeeId, organizationId },
        select: { joiningDate: true },
      });
      const joined = employee?.joiningDate
        ? dateOnly(employee.joiningDate)
        : null;
      if (joined && from < joined) {
        throw new BadRequestException(
          `The first salary can be moved earlier only down to the joining date (${dmyText(joined)}).`,
        );
      }
      moveFirstStart = true;
    }
    // A deliberate backdated revision (to be paid as arrears) is allowed to start inside paid months; the locked
    // payslips are left alone and the difference is paid via PayrollService.createArrears.
    if (dto.backdateForArrears !== true) {
      await this.assertNoFinalizedPayrollFrom(employeeId, from, organizationId);
    }
    const sameDay =
      !!current && (from === current.effectiveFrom || moveFirstStart);

    const values = {
      valueType: dto.valueType ?? component.calcType,
      fixedAmount: dto.fixedAmount ?? null,
      percentageValue: dto.percentageValue ?? null,
      percentageOf: dto.percentageOf ?? null,
      formula: dto.formula ?? null,
      amountBasis: dto.amountBasis ?? 'MONTHLY',
      isEnabled: dto.isEnabled ?? true,
      revisionNote: dto.revisionNote ?? '',
    };
    // Close-out and insert are one atomic step: a failure between them used to leave the old row closed with no
    // successor (the component silently disappearing from the structure), and a double submit could leave two
    // open rows. A partial unique index on the open row backs this up at the database level.
    let created: EmployeeSalaryComponent;
    try {
      created = await this.scopedPrisma.$transaction(async (tx) => {
        if (current && !sameDay) {
          await tx.employeeSalaryComponent.updateMany({
            where: { id: current.id, organizationId, effectiveTo: null },
            data: { effectiveTo: dayBefore(from) },
          });
        }
        if (sameDay && current) {
          await tx.employeeSalaryComponent.updateMany({
            where: { id: current.id, organizationId },
            data: moveFirstStart ? { ...values, effectiveFrom: from } : values,
          });
          return tx.employeeSalaryComponent.findFirstOrThrow({
            where: { id: current.id, organizationId },
          });
        }
        return tx.employeeSalaryComponent.create({
          data: {
            organizationId,
            employeeId,
            componentId: component.id,
            componentCode: component.code,
            ...values,
            effectiveFrom: from,
            effectiveTo: null,
            createdById: actorId,
          },
        });
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new BadRequestException(
          `${component.code} was just revised by someone else - reload and try again.`,
        );
      }
      throw err;
    }

    // A compensation change — same sensitivity class as EMPLOYEE_UPDATED's
    // role/department/isActive transitions (see EmployeesService.update),
    // which do get an AuditLog row; this sibling write path (the org's
    // salary-*component-definition* CRUD in SalaryComponentsService already
    // logs SALARY_COMPONENT_*) was silently exempt. before/after mirrors
    // that convention so a pay-rate change is traceable the same way.
    await this.auditLogService.log({
      actorId,
      action: 'EMPLOYEE_SALARY_COMPONENT_SET',
      module: 'PAYROLL',
      organizationId,
      targetId: employeeId,
      details: {
        componentCode: component.code,
        effectiveFrom: from,
        // An Admin revising their own pay - flagged so it stands out in the audit trail.
        selfRevision: actorId === employeeId,
        before: current
          ? {
              fixedAmount: current.fixedAmount,
              percentageValue: current.percentageValue,
              percentageOf: current.percentageOf,
              formula: current.formula,
              isEnabled: current.isEnabled,
            }
          : null,
        after: {
          fixedAmount: created.fixedAmount,
          percentageValue: created.percentageValue,
          percentageOf: created.percentageOf,
          formula: created.formula,
          isEnabled: created.isEnabled,
        },
      },
    });

    // One SALARY_REVISION timeline event per applied revision. Amounts stay out on purpose — the timeline
    // is visible to the employee; only the component code, effective date and HR's revision note are shown.
    await this.timelineService.logEvent({
      organizationId,
      employeeId,
      eventKey: 'SALARY_REVISION',
      performedById: actorId,
      description: component.name,
      remarks: dto.revisionNote ?? '',
      metadata: { componentCode: component.code, effectiveFrom: from },
    });

    return created;
  }

  // A revision effective in (or before) a month this employee has already
  // been paid for — a LOCKED or PAID regular payroll run — can never reach
  // that payslip (locked runs are not recalculated), so it used to be
  // accepted and then silently ignored for those months. Rejected instead:
  // unlock the run to redo it, or date the revision after it and pay any
  // difference as arrears.
  private async assertNoFinalizedPayrollFrom(
    employeeId: string,
    effectiveFrom: string,
    organizationId: string,
  ) {
    const fromYear = Number(effectiveFrom.slice(0, 4));
    const fromMonth = Number(effectiveFrom.slice(5, 7));
    const finalized = await this.scopedPrisma.payrollRun.findFirst({
      where: {
        organizationId,
        employeeId,
        isFinalSettlement: false,
        runSequence: 0,
        status: { in: [PayrollRunStatus.LOCKED, PayrollRunStatus.PAID] },
        OR: [
          { year: { gt: fromYear } },
          { year: fromYear, month: { gte: fromMonth } },
        ],
      },
      orderBy: [{ year: 'asc' }, { month: 'asc' }],
      select: { month: true, year: true, status: true },
    });
    if (finalized) {
      throw new BadRequestException(
        `Cannot apply a salary revision effective ${dmyText(effectiveFrom)}: this employee's ${finalized.month}/${finalized.year} payroll is already ${finalized.status.toLowerCase()}. Unlock that payroll run first, or choose an effective date after it and pay any difference as arrears, or send backdateForArrears to record a backdated revision and pay the difference through Arrears.`,
      );
    }
  }

  // Resolves an employee's current monthly value for a single component
  // code (e.g. 'BASIC'), reading from their live structure rather than a
  // full payroll run — ported from the original release's
  // getCurrentComponentMonthlyValue, used by Leave Encashment's rate
  // calculation and reused verbatim by Payroll core later.
  async getCurrentMonthlyValue(
    employeeId: string,
    code: string,
    asOf: string,
    organizationId: string,
  ): Promise<number> {
    const component = await this.scopedPrisma.salaryComponent.findFirst({
      where: { organizationId, code },
    });
    if (!component) return 0;

    const rows = await this.scopedPrisma.employeeSalaryComponent.findMany({
      where: { organizationId, employeeId },
    });
    const current = resolveCurrentRows(rows, asOf);
    const overridesByCode = new Map(current.map((r) => [r.componentCode, r]));
    const override = overridesByCode.get(code) ?? null;

    if (override && override.isEnabled === false) return 0;

    const context: Record<string, number> = {};
    for (const dep of extractDependencies(component, override)) {
      if (context[dep] !== undefined) continue;
      const depComponent = await this.scopedPrisma.salaryComponent.findFirst({
        where: { organizationId, code: dep },
      });
      if (!depComponent) continue;
      context[dep] = resolveComponentValue(
        depComponent,
        overridesByCode.get(dep) ?? null,
        {},
      );
    }

    return resolveComponentValue(component, override, context);
  }

  private async resolveComponentOrThrow(
    dto: { componentId?: string; componentCode?: string },
    organizationId: string,
  ): Promise<SalaryComponent> {
    const component = await this.resolveComponent(dto, organizationId);
    if (!component) throw new NotFoundException('Salary component not found.');
    return component;
  }

  private resolveComponent(
    dto: { componentId?: string; componentCode?: string },
    organizationId: string,
  ): Promise<SalaryComponent | null> {
    if (!dto.componentId && !dto.componentCode) return Promise.resolve(null);
    const where: Prisma.SalaryComponentWhereInput = dto.componentId
      ? { id: dto.componentId, organizationId }
      : { code: dto.componentCode, organizationId };
    return this.scopedPrisma.salaryComponent.findFirst({ where });
  }

  private async assertEmployeeExists(
    employeeId: string,
    organizationId: string,
  ) {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
  }
}
