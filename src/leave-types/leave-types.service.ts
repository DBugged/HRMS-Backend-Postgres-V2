// Purpose: CRUD for LeaveType policy definitions, plus balance recalculation and year-end carry-forward runs.
// Responsibilities: Owns leave-type name/code uniqueness and registration-time default seeding
// (seedDefaults, called from AuthService.register()); delegates actual balance math to
// LeaveBalanceService.reconcileUpfrontCredit/runYearEndCarryForward and audits both runs via AuditLogService.
// Important: rules/carryForward/negativeBalance/encashment are opaque JSON columns validated only by the
// DTO shape, not by a DB schema — keep leave-type-defaults.ts's shapes in sync with what the engine expects.
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AllocationType, LeaveType, Prisma, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { LeaveBalanceService } from '../leave-balances/leave-balance.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CreateLeaveTypeDto } from './dto/create-leave-type.dto';
import { UpdateLeaveTypeDto } from './dto/update-leave-type.dto';
import { RunCarryForwardDto } from './dto/run-carry-forward.dto';
import { wrapAll } from '../common/pagination';
import { DEFAULT_RULES, LEAVE_TYPE_DEFAULTS } from './leave-type-defaults';

// The only negative-balance setting a leave type can have now (see create/update below).
const NO_NEGATIVE_BALANCE = { allowed: false, maxNegativeDays: 0 };

@Injectable()
export class LeaveTypesService {
  private readonly logger = new Logger(LeaveTypesService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly leaveBalanceService: LeaveBalanceService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // The audit log needs a user as its actor, and a scheduled run has none. The organization's oldest active Admin
  // stands in; every scheduled entry is marked details.source = 'SCHEDULED' (and the history shows "scheduled run"
  // rather than that person's name), so it is never mistaken for something they did.
  private async systemActorId(organizationId: string): Promise<string | null> {
    const admin = await this.scopedPrisma.user.findFirst({
      where: { organizationId, isActive: true, role: Role.ADMIN },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return admin?.id ?? null;
  }

  // Opt-in org-level automation (Organization Settings > General Settings > "Automatic Year-End Carry Forward") for
  // orgs that don't want to rely on someone remembering to click "Run Year-End Carry Forward" every January.
  // Leave-balance years are plain calendar years (see the `new Date().getFullYear()` uses in
  // leave-balance.service.ts), independent of the org's financialYearStartMonth, which only affects payroll/tax.
  //
  // It used to fire only if the server happened to be running on 1 January, so a restart, deploy or outage on that
  // one day skipped carry-forward for the whole year with nothing to say so. It now checks every day of January and
  // runs for each organization that has no scheduled carry-forward for the closing year on record (the history entry
  // it writes is the marker), so a missed 1 January is picked up the next day the server is up. Once recorded it does
  // not run again, so later edits to January data are not silently re-carried.
  @Cron('0 3 * * *')
  async autoRunCarryForwardDailyCheck() {
    const today = new Date();
    if (today.getMonth() !== 0) return;
    const previousYear = today.getFullYear() - 1;

    const organizations = await this.scopedPrisma.organization.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    for (const org of organizations) {
      try {
        await this.autoRunCarryForwardForOrg(org.id, previousYear);
      } catch (err) {
        this.logger.error(
          `Auto carry-forward failed for org ${org.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  async autoRunCarryForwardForOrg(
    organizationId: string,
    previousYear: number,
  ) {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { policies: true },
    });
    const policies = org?.policies as {
      autoCarryForwardEnabled?: boolean;
    } | null;
    if (!policies?.autoCarryForwardEnabled) return { ran: false as const };

    const alreadyDone = await this.scopedPrisma.auditLog.findFirst({
      where: {
        organizationId,
        action: 'LEAVE_CARRYFORWARD_RUN',
        AND: [
          { details: { path: ['source'], equals: 'SCHEDULED' } },
          { details: { path: ['year'], equals: previousYear } },
        ],
      },
      select: { id: true },
    });
    if (alreadyDone) return { ran: false as const };

    const { processed, disabledByOrg } =
      await this.leaveBalanceService.runYearEndCarryForward(
        previousYear,
        organizationId,
      );
    if (disabledByOrg) return { ran: false as const };

    const actorId = await this.systemActorId(organizationId);
    if (actorId) {
      await this.auditLogService.log({
        actorId,
        action: 'LEAVE_CARRYFORWARD_RUN',
        module: 'LEAVE',
        organizationId,
        details: { year: previousYear, processed, source: 'SCHEDULED' },
      });
    }
    return { ran: true as const, processed };
  }

  // Every new org starts with the standard leave-type set (Casual, Sick,
  // Earned, Maternity, etc.) instead of an empty Leave Types page — admin
  // can edit/disable/add to these from Leave Types afterward. Same
  // registration-time integration point as StatutoryConfigService.seedDefaults.
  async seedDefaults(
    tx: Prisma.TransactionClient,
    organizationId: string,
    createdById?: string,
  ): Promise<void> {
    for (const def of LEAVE_TYPE_DEFAULTS) {
      const { carryForward, encashment, rules, ...rest } = def;
      await tx.leaveType.create({
        data: {
          ...rest,
          organizationId,
          createdById,
          isSystemDefault: true,
          rules: { ...DEFAULT_RULES, ...rules },
          ...(carryForward !== undefined && {
            carryForward: carryForward,
          }),
          ...(encashment !== undefined && {
            encashment: encashment,
          }),
        },
      });
    }
  }

  async create(
    dto: CreateLeaveTypeDto,
    organizationId: string,
    createdById: string,
  ) {
    await this.assertNoDuplicate(organizationId, dto.name, dto.code);
    const created = await this.scopedPrisma.leaveType.create({
      data: {
        organizationId,
        name: dto.name,
        code: dto.code,
        description: dto.description ?? '',
        color: dto.color ?? '#3b82f6',
        isPaid: dto.isPaid ?? true,
        displayOrder: dto.displayOrder ?? 0,
        allocationType: dto.allocationType,
        annualQuota: dto.annualQuota ?? 0,
        prorateOnJoining: dto.prorateOnJoining ?? true,
        applicableDepartments: dto.applicableDepartments ?? [],
        applicableEmployeeTypes: dto.applicableEmployeeTypes ?? [],
        applicableGenders: dto.applicableGenders ?? [],
        minServiceMonths: dto.minServiceMonths ?? 0,
        maxServiceMonths: dto.maxServiceMonths,
        salaryImpactPercent: dto.salaryImpactPercent ?? 100,
        affectsLopCalculation: dto.affectsLopCalculation ?? true,
        showInLeaveTracker: dto.showInLeaveTracker ?? true,
        requiresApproval: dto.requiresApproval ?? true,
        approvalLevels: dto.approvalLevels ?? 2,
        autoApproveIfNoAction: dto.autoApproveIfNoAction ?? false,
        autoApproveHours: dto.autoApproveHours ?? 0,
        ...(dto.rules !== undefined && {
          rules: dto.rules as unknown as Prisma.InputJsonValue,
        }),
        documentsRequired: dto.documentsRequired ?? false,
        countInTotalBalance: dto.countInTotalBalance ?? true,
        documentRequiredAfterDays: dto.documentRequiredAfterDays,
        ...(dto.carryForward !== undefined && {
          carryForward: dto.carryForward as unknown as Prisma.InputJsonValue,
        }),
        // Leave never goes negative: whatever the request says, the type is stored with negative balance off. Days
        // beyond the quota are taken as Leave Without Pay (pay is deducted for them).
        negativeBalance:
          NO_NEGATIVE_BALANCE as unknown as Prisma.InputJsonValue,
        ...(dto.encashment !== undefined && {
          encashment: dto.encashment as unknown as Prisma.InputJsonValue,
        }),
        createdById,
      },
    });
    await this.creditNewType(created, createdById, organizationId);
    return created;
  }

  // A new leave type credits everyone who is eligible right away (see seedBalancesForNewType) and that credit goes into
  // the Accrual History like any other, so "who was given what, and when" is on record from day one. A failure here
  // never fails the creation: balances are still created on first use, exactly as before.
  private async creditNewType(
    leaveType: LeaveType,
    actorId: string,
    organizationId: string,
  ) {
    try {
      const { rows, totalDaysCredited } =
        await this.leaveBalanceService.seedBalancesForNewType(
          leaveType,
          organizationId,
        );
      if (rows === 0) return;
      await this.auditLogService.log({
        actorId,
        action: 'LEAVE_ACCRUAL_RUN',
        module: 'LEAVE',
        organizationId,
        targetId: leaveType.id,
        details: {
          leaveType: leaveType.code,
          matched: rows,
          credited: rows,
          alreadyAccrued: 0,
          behind: 0,
          totalDaysCredited,
          repaired: 0,
          repairedDays: 0,
          source: 'CREATED',
        },
      });
    } catch (err) {
      this.logger.error(
        `Crediting new leave type ${leaveType.code} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async findAll(organizationId: string, activeOnly?: boolean) {
    const data = await this.scopedPrisma.leaveType.findMany({
      where: { organizationId, ...(activeOnly && { isActive: true }) },
      orderBy: { displayOrder: 'asc' },
    });
    return wrapAll(data);
  }

  async findOne(id: string, organizationId: string) {
    return this.findByIdOrThrow(id, organizationId);
  }

  async update(
    id: string,
    dto: UpdateLeaveTypeDto,
    organizationId: string,
    actorId?: string,
  ) {
    const existing = await this.findByIdOrThrow(id, organizationId);

    // A built-in's name/code is what other modules key off of (see
    // reserved-codes.ts's LEAVE_TYPE_CODES.COMPOFF) — everything else about
    // it (quota, accrual, applicability...) still needs to stay editable
    // per-org, so only these two fields are locked.
    if (
      existing.isSystemDefault &&
      ((dto.name !== undefined && dto.name !== existing.name) ||
        (dto.code !== undefined && dto.code !== existing.code))
    ) {
      throw new ConflictException(
        'This is a built-in leave type — its name and code cannot be changed.',
      );
    }

    await this.assertNoDuplicate(
      organizationId,
      dto.name ?? existing.name,
      dto.code ?? existing.code,
      id,
    );

    // Quota-affecting edits must reach existing balance rows too (they're
    // only computed at row-creation time) — done in the same transaction so
    // the quota change and the balance reconciliation are atomic.
    const upfrontFieldsChanged =
      (dto.annualQuota !== undefined &&
        dto.annualQuota !== existing.annualQuota) ||
      (dto.allocationType !== undefined &&
        dto.allocationType !== existing.allocationType) ||
      (dto.prorateOnJoining !== undefined &&
        dto.prorateOnJoining !== existing.prorateOnJoining);

    let rowsReconciled = 0;
    await this.scopedPrisma.$transaction(async (tx) => {
      await tx.leaveType.updateMany({
        where: { id, organizationId },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.code !== undefined && { code: dto.code }),
          ...(dto.description !== undefined && {
            description: dto.description,
          }),
          ...(dto.color !== undefined && { color: dto.color }),
          ...(dto.isActive !== undefined && { isActive: dto.isActive }),
          ...(dto.isPaid !== undefined && { isPaid: dto.isPaid }),
          ...(dto.displayOrder !== undefined && {
            displayOrder: dto.displayOrder,
          }),
          ...(dto.allocationType !== undefined && {
            allocationType: dto.allocationType,
          }),
          ...(dto.annualQuota !== undefined && {
            annualQuota: dto.annualQuota,
          }),
          ...(dto.prorateOnJoining !== undefined && {
            prorateOnJoining: dto.prorateOnJoining,
          }),
          ...(dto.applicableDepartments !== undefined && {
            applicableDepartments: dto.applicableDepartments,
          }),
          ...(dto.applicableEmployeeTypes !== undefined && {
            applicableEmployeeTypes: dto.applicableEmployeeTypes,
          }),
          ...(dto.applicableGenders !== undefined && {
            applicableGenders: dto.applicableGenders,
          }),
          ...(dto.minServiceMonths !== undefined && {
            minServiceMonths: dto.minServiceMonths,
          }),
          ...(dto.maxServiceMonths !== undefined && {
            maxServiceMonths: dto.maxServiceMonths,
          }),
          ...(dto.salaryImpactPercent !== undefined && {
            salaryImpactPercent: dto.salaryImpactPercent,
          }),
          ...(dto.showInLeaveTracker !== undefined && {
            showInLeaveTracker: dto.showInLeaveTracker,
          }),
          ...(dto.affectsLopCalculation !== undefined && {
            affectsLopCalculation: dto.affectsLopCalculation,
          }),
          ...(dto.requiresApproval !== undefined && {
            requiresApproval: dto.requiresApproval,
          }),
          ...(dto.approvalLevels !== undefined && {
            approvalLevels: dto.approvalLevels,
          }),
          ...(dto.autoApproveIfNoAction !== undefined && {
            autoApproveIfNoAction: dto.autoApproveIfNoAction,
          }),
          ...(dto.autoApproveHours !== undefined && {
            autoApproveHours: dto.autoApproveHours,
          }),
          ...(dto.rules !== undefined && {
            rules: dto.rules as unknown as Prisma.InputJsonValue,
          }),
          ...(dto.documentsRequired !== undefined && {
            documentsRequired: dto.documentsRequired,
          }),
          ...(dto.countInTotalBalance !== undefined && {
            countInTotalBalance: dto.countInTotalBalance,
          }),
          ...(dto.documentRequiredAfterDays !== undefined && {
            documentRequiredAfterDays: dto.documentRequiredAfterDays,
          }),
          ...(dto.carryForward !== undefined && {
            carryForward: dto.carryForward as unknown as Prisma.InputJsonValue,
          }),
          ...(dto.negativeBalance !== undefined && {
            negativeBalance:
              NO_NEGATIVE_BALANCE as unknown as Prisma.InputJsonValue,
          }),
          ...(dto.encashment !== undefined && {
            encashment: dto.encashment as unknown as Prisma.InputJsonValue,
          }),
        },
      });

      if (upfrontFieldsChanged) {
        const updated = await tx.leaveType.findFirstOrThrow({
          where: { id, organizationId },
        });
        const reconciled =
          await this.leaveBalanceService.reconcileUpfrontCredit(
            tx,
            updated,
            organizationId,
          );
        rowsReconciled = reconciled.rowsUpdated;
      }
    });

    const updated = await this.findByIdOrThrow(id, organizationId);
    await this.auditPolicyChange(
      existing,
      updated,
      rowsReconciled,
      actorId,
      organizationId,
    );
    return updated;
  }

  // There are no effective dates on a leave type, so a policy edit applies from the moment it is saved: this year's
  // balances (upfront and per-cycle types alike) are recalculated to the new rule (reconcileUpfrontCredit). The
  // before/after of every rule that drives balances is recorded here, with how many balances were recalculated, so a
  // changed balance can be traced back to the edit that caused it.
  private async auditPolicyChange(
    before: LeaveType,
    after: LeaveType,
    rowsReconciled: number,
    actorId: string | undefined,
    organizationId: string,
  ) {
    if (!actorId) return;
    const fields = [
      'allocationType',
      'annualQuota',
      'prorateOnJoining',
      'minServiceMonths',
      'maxServiceMonths',
      'carryForward',
      'negativeBalance',
      'encashment',
    ] as const;
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const f of fields) {
      if (JSON.stringify(before[f]) !== JSON.stringify(after[f])) {
        changes[f] = { from: before[f], to: after[f] };
      }
    }
    if (Object.keys(changes).length === 0) return;
    await this.auditLogService.log({
      actorId,
      action: 'LEAVE_TYPE_POLICY_CHANGED',
      module: 'LEAVE',
      organizationId,
      targetId: after.id,
      details: { leaveType: after.code, changes, rowsReconciled },
    });
  }

  async remove(id: string, organizationId: string) {
    const existing = await this.findByIdOrThrow(id, organizationId);
    if (existing.isSystemDefault) {
      throw new ConflictException(
        'This is a built-in leave type and cannot be deleted — deactivate it instead.',
      );
    }

    // Deleting a leave type that already has balances or requests against
    // it would otherwise hit the FK constraint (Leave/LeaveBalance both
    // reference leaveTypeId with no onDelete) as an unhandled 500 — this
    // turns that into a clear, actionable message instead.
    //
    // A new leave type gets a balance row for every eligible employee the moment it is created, so a row existing is
    // not "in use" by itself: only leave requests, encashments, or a balance that has actually moved (carried in,
    // taken, held, encashed or adjusted) block the delete. Untouched rows go with the type.
    const [movedBalances, leaveCount, encashmentCount] = await Promise.all([
      this.scopedPrisma.leaveBalance.count({
        where: {
          leaveTypeId: id,
          organizationId,
          OR: [
            { opening: { not: 0 } },
            { availed: { not: 0 } },
            { pending: { not: 0 } },
            { encashed: { not: 0 } },
            { adjusted: { not: 0 } },
          ],
        },
      }),
      this.scopedPrisma.leave.count({
        where: { leaveTypeId: id, organizationId },
      }),
      this.scopedPrisma.leaveEncashment.count({
        where: { leaveTypeId: id, organizationId },
      }),
    ]);
    if (movedBalances > 0 || leaveCount > 0 || encashmentCount > 0) {
      throw new BadRequestException(
        `This leave type is in use (${leaveCount} leave request(s), ${encashmentCount} encashment(s), ${movedBalances} balance(s) with activity) and cannot be deleted — deactivate it instead.`,
      );
    }

    await this.scopedPrisma.$transaction([
      this.scopedPrisma.leaveBalance.deleteMany({
        where: { leaveTypeId: id, organizationId },
      }),
      this.scopedPrisma.leaveType.deleteMany({
        where: { id, organizationId },
      }),
    ]);
    return { message: 'Leave type deleted' };
  }

  getEligibleForMe(employeeId: string, organizationId: string) {
    return this.leaveBalanceService.getEligibleLeaveTypes(
      employeeId,
      organizationId,
    );
  }

  // Recalculates this year's balances for every quota-based leave type to its upfront rule: the whole Annual Quota,
  // prorated for anyone who joined this year (reconcileUpfrontCredit). Used once after the per-cycle accrual was
  // removed, and any time balances need bringing back in line. With dryRun it only reports what would change.
  async recalculateBalances(
    actorId: string,
    organizationId: string,
    dryRun: boolean,
  ) {
    const leaveTypes = await this.scopedPrisma.leaveType.findMany({
      where: {
        organizationId,
        isActive: true,
        allocationType: {
          in: [
            AllocationType.FIXED_ANNUAL,
            AllocationType.PRORATED_ON_JOINING,
            AllocationType.EARNED_MONTHLY,
          ],
        },
      },
      orderBy: { displayOrder: 'asc' },
    });
    const results: {
      leaveType: string;
      code: string;
      changes: {
        employeeId: string;
        employeeCode: string;
        name: string;
        from: number;
        to: number;
      }[];
    }[] = [];
    for (const lt of leaveTypes) {
      const { changes } = await this.scopedPrisma.$transaction((tx) =>
        this.leaveBalanceService.reconcileUpfrontCredit(
          tx,
          lt,
          organizationId,
          { dryRun },
        ),
      );
      if (changes.length > 0) {
        results.push({ leaveType: lt.name, code: lt.code, changes });
      }
    }
    const balancesChanged = results.reduce((n, r) => n + r.changes.length, 0);
    if (!dryRun && balancesChanged > 0) {
      await this.auditLogService.log({
        actorId,
        action: 'LEAVE_BALANCES_RECALCULATED',
        module: 'LEAVE',
        organizationId,
        details: {
          leaveTypes: results.map((r) => r.code),
          balancesChanged,
        },
      });
    }
    return { dryRun, balancesChanged, results };
  }

  async runCarryForward(
    dto: RunCarryForwardDto,
    actorId: string,
    organizationId: string,
  ) {
    const year = dto.year ?? new Date().getFullYear();
    const { processed, disabledByOrg } =
      await this.leaveBalanceService.runYearEndCarryForward(
        year,
        organizationId,
      );
    if (disabledByOrg) {
      throw new BadRequestException(
        'Carry forward is turned off for the whole organization (Organization Settings → Policies).',
      );
    }
    await this.auditLogService.log({
      actorId,
      action: 'LEAVE_CARRYFORWARD_RUN',
      module: 'LEAVE',
      organizationId,
      details: { year, processed },
    });
    return {
      message: `Carried forward balances for ${processed} employee/leave-type combination(s)`,
      processed,
      year,
    };
  }

  private async assertNoDuplicate(
    organizationId: string,
    name: string,
    code: string,
    excludeId?: string,
  ) {
    const duplicate = await this.scopedPrisma.leaveType.findFirst({
      where: {
        organizationId,
        OR: [{ name }, { code }],
        ...(excludeId && { id: { not: excludeId } }),
      },
    });
    if (duplicate) {
      throw new ConflictException(
        'A leave type with this name or code already exists.',
      );
    }
  }

  private async findByIdOrThrow(
    id: string,
    organizationId: string,
  ): Promise<LeaveType> {
    const leaveType = await this.scopedPrisma.leaveType.findFirst({
      where: { id, organizationId },
    });
    if (!leaveType) throw new NotFoundException('Leave type not found.');
    return leaveType;
  }
}
