// Purpose: Owns the leave-balance ledger — get-or-create per (employee, leaveType, year), the single
// recalculate() writer for `closing`, accrual crediting, and year-end carry-forward.
// Responsibilities: Wraps the pure math in leave-eligibility.ts/leave-balance-math.ts with the actual DB
// reads/writes; exposed cross-module (e.g. to LeaveEncashmentsService, LeaveTypesService) as the one place
// balance mutations happen, mirroring the old backend's leavePolicyEngine.js.
// Important: ensureBalanceRow()/recalculate() must be called with a transaction client so the
// read-then-maybe-create/read-then-write is atomic under concurrent callers. Every quota-based type is
// granted upfront (prorated for a mid-year joiner); there is no per-cycle accrual.
import { randomUUID } from 'crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AllocationType,
  LeaveBalance,
  LeaveStatus,
  LeaveType,
  Prisma,
  Role,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { isEligible } from './leave-eligibility';
import { getOrgLeaveSwitches } from '../organizations/org-leave-switches';
import {
  computeCarriedInExpiry,
  computeCarryOut,
  computeUpfrontCredit,
  availedBeforeExpiry,
  forfeitedCarryIn,
  isCarriedInExpired,
  recalcClosing,
} from './leave-balance-math';

interface CarryForwardShape {
  allowed: boolean;
  maxDays: number;
  expiryMonths: number | null;
}

// Roles eligible for leave accrual/balance tracking. Originally ported as
// just EMPLOYEE/MANAGER (old system's 'employee'/'department_head' —
// administrator/hr_admin were never included), but backend-v2's My Leave
// is self-service for every role, including ADMIN and HR — an Admin or
// HR user can apply for leave and see a balance, so excluding them here
// silently starved their own balance of the same accrual runs everyone
// else's leave depends on. Every role now goes through the same
// isEligible() department/employeeType/gender/service-month filter below,
// so this list is just "which roles have leave tracked at all," not a
// second layer of eligibility.
const ACCRUAL_ELIGIBLE_ROLES: Role[] = [
  Role.ADMIN,
  Role.HR,
  Role.MANAGER,
  Role.EMPLOYEE,
];

/**
 * Orchestrating service for the leave-balance engine — wraps the pure
 * functions in leave-eligibility.ts/leave-balance-math.ts with the DB reads/
 * writes the old backend's leavePolicyEngine.js performed. Exported from
 * LeaveBalancesModule so the future Leave-requests module (Batch 4b) can
 * inject it too (same cross-module pattern as EmployeeIdService).
 */
@Injectable()
export class LeaveBalanceService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  /**
   * The opening/credited a brand-new balance row starts with: last year's carried-forward days plus the upfront credit
   * (the annual quota, prorated for someone who joined this year). Shared by ensureBalanceRow (one row) and
   * ensureBalanceRowsBulk (many) so both always agree.
   */
  private initialBalanceFor(
    joiningDate: Date,
    leaveType: LeaveType,
    year: number,
    priorYearRow: { carriedForwardOut: number } | null | undefined,
  ) {
    const opening = priorYearRow?.carriedForwardOut ?? 0;
    const credited = computeUpfrontCredit(leaveType, joiningDate, year);
    return { opening, credited, lastAccrualPeriod: null as string | null };
  }

  /**
   * Bulk variant of ensureBalanceRow for read paths that need many employees' rows at once
   * (the Leave Tracker balances view). Creates every missing (employee, leaveType, year) row with
   * a handful of queries total — instead of ~5 queries + a transaction per employee, which took
   * ~37s for 1,500 employees on first load of a year. Same ON CONFLICT DO NOTHING semantics, so
   * it is safe against concurrent callers. Returns the rows keyed `${employeeId}:${leaveTypeId}`.
   */
  async ensureBalanceRowsBulk(
    pairs: { employeeId: string; leaveTypeId: string }[],
    year: number,
    organizationId: string,
    employees: { id: string; joiningDate: Date }[],
    leaveTypes: LeaveType[],
  ): Promise<Map<string, LeaveBalance>> {
    const result = new Map<string, LeaveBalance>();
    if (pairs.length === 0) return result;
    const joiningById = new Map(employees.map((e) => [e.id, e.joiningDate]));
    const typeById = new Map(leaveTypes.map((t) => [t.id, t]));
    const employeeIds = [...new Set(pairs.map((p) => p.employeeId))];

    const priorRows = await this.scopedPrisma.leaveBalance.findMany({
      where: {
        organizationId,
        employeeId: { in: employeeIds },
        year: year - 1,
      },
    });
    const priorByKey = new Map(
      priorRows.map((r) => [`${r.employeeId}:${r.leaveTypeId}`, r]),
    );

    const values = pairs.flatMap((pair) => {
      const joiningDate = joiningById.get(pair.employeeId);
      const leaveType = typeById.get(pair.leaveTypeId);
      if (!joiningDate || !leaveType) return [];
      const { opening, credited, lastAccrualPeriod } = this.initialBalanceFor(
        joiningDate,
        leaveType,
        year,
        priorByKey.get(`${pair.employeeId}:${pair.leaveTypeId}`),
      );
      return [
        Prisma.sql`(${randomUUID()}, ${organizationId}, ${pair.employeeId}, ${pair.leaveTypeId}, ${year}, ${opening}, ${credited}, ${opening + credited}, ${lastAccrualPeriod}, now(), now())`,
      ];
    });

    const CHUNK = 500;
    for (let i = 0; i < values.length; i += CHUNK) {
      const chunk = values.slice(i, i + CHUNK);
      await this.scopedPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          INSERT INTO leave_balances
            (id, "organizationId", "employeeId", "leaveTypeId", "year", "opening", "credited", "closing", "lastAccrualPeriod", "createdAt", "updatedAt")
          VALUES ${Prisma.join(chunk)}
          ON CONFLICT ("organizationId", "employeeId", "leaveTypeId", "year") DO NOTHING
        `;
      });
    }

    const rows = await this.scopedPrisma.leaveBalance.findMany({
      where: { organizationId, employeeId: { in: employeeIds }, year },
    });
    for (const r of rows) result.set(`${r.employeeId}:${r.leaveTypeId}`, r);
    return result;
  }

  /**
   * Creates this year's balance row for every active, eligible employee the moment a leave type is created, so what
   * each person is credited exists (and can be recorded in the credit history) right away instead of appearing the
   * first time someone opens their balance. Inactive employees earn no leave and get no row. Returns how many rows
   * were created and the days they were credited in total.
   */
  async seedBalancesForNewType(
    leaveType: LeaveType,
    organizationId: string,
  ): Promise<{ rows: number; totalDaysCredited: number }> {
    if (
      !leaveType.isActive ||
      leaveType.allocationType === AllocationType.NONE ||
      leaveType.allocationType === AllocationType.UNLIMITED
    ) {
      return { rows: 0, totalDaysCredited: 0 };
    }
    const now = new Date();
    const employees = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        role: { in: ACCRUAL_ELIGIBLE_ROLES },
      },
      select: {
        id: true,
        joiningDate: true,
        departmentId: true,
        employeeType: true,
        gender: true,
      },
    });
    const eligible = employees.filter(
      (e) => e.joiningDate <= now && isEligible(leaveType, e),
    );
    if (eligible.length === 0) return { rows: 0, totalDaysCredited: 0 };

    const rows = await this.ensureBalanceRowsBulk(
      eligible.map((e) => ({ employeeId: e.id, leaveTypeId: leaveType.id })),
      now.getFullYear(),
      organizationId,
      eligible,
      [leaveType],
    );
    // ensureBalanceRowsBulk returns every balance row these employees hold for the year (all leave types), so only
    // this type's rows are counted.
    const own = [...rows.values()].filter((r) => r.leaveTypeId === leaveType.id);
    let total = 0;
    for (const row of own) total += row.credited;
    return {
      rows: own.length,
      totalDaysCredited: Math.round(total * 100) / 100,
    };
  }

  /**
   * Get-or-create for (employee, leaveType, year). Must be called with a
   * transaction client so this is atomic under concurrent callers, same
   * reasoning as EmployeeIdService.generate.
   *
   * Two concurrent apply()/review()/getBalance() calls for the same
   * employee+leaveType+year (its first time being touched, so no row
   * exists yet) could both pass the findFirst "no row" check below before
   * either commits, then both reach create(), and the
   * @@unique([organizationId, employeeId, leaveTypeId, year]) constraint
   * lets exactly one win. The loser used to throw an unhandled Prisma
   * P2002 straight out of the surrounding `tx.$transaction` callback —
   * and because that's an interactive transaction, catching it and
   * retrying with another query on the same `tx` isn't an option (Postgres
   * has already marked the transaction aborted), so the whole calling
   * operation (leave apply, review, cancel, balance lookup) failed with a
   * raw "already exists" 409/500 instead of just resolving to the row the
   * winner created.
   *
   * Fixed with `INSERT ... ON CONFLICT DO NOTHING` via a raw query instead
   * of Prisma's `create`/`upsert` — `upsert` is a forbidden op on
   * tenant-scoped models here (see FORBIDDEN_UNIQUE_OPS in
   * tenant-scope.guard-logic.ts: it takes a unique-only `where` that can't
   * also carry an organizationId filter), and a plain `create` is exactly
   * what raced in the first place. `ON CONFLICT DO NOTHING` never throws —
   * the loser's INSERT just affects 0 rows — so the transaction stays
   * healthy and the subsequent findFirst (below) reads whichever row won,
   * same raw-query pattern issueDocumentNumber uses for its row lock.
   */
  async ensureBalanceRow(
    tx: Prisma.TransactionClient,
    employeeId: string,
    leaveTypeId: string,
    year: number,
    organizationId: string,
  ): Promise<LeaveBalance> {
    const existing = await tx.leaveBalance.findFirst({
      where: { organizationId, employeeId, leaveTypeId, year },
    });
    if (existing) return existing;

    const [employee, leaveType, priorYearRow] = await Promise.all([
      tx.user.findFirst({ where: { id: employeeId, organizationId } }),
      tx.leaveType.findFirst({ where: { id: leaveTypeId, organizationId } }),
      tx.leaveBalance.findFirst({
        where: { organizationId, employeeId, leaveTypeId, year: year - 1 },
      }),
    ]);
    if (!employee) throw new NotFoundException('Employee not found.');
    if (!leaveType) throw new NotFoundException('Leave type not found.');

    const { opening, credited, lastAccrualPeriod } = this.initialBalanceFor(
      employee.joiningDate,
      leaveType,
      year,
      priorYearRow,
    );

    await tx.$executeRaw`
      INSERT INTO leave_balances
        (id, "organizationId", "employeeId", "leaveTypeId", "year", "opening", "credited", "closing", "lastAccrualPeriod", "createdAt", "updatedAt")
      VALUES
        (${randomUUID()}, ${organizationId}, ${employeeId}, ${leaveTypeId}, ${year}, ${opening}, ${credited}, ${opening + credited}, ${lastAccrualPeriod}, now(), now())
      ON CONFLICT ("organizationId", "employeeId", "leaveTypeId", "year") DO NOTHING
    `;

    // Whichever of this call and its concurrent racers actually inserted
    // (or, on the no-race path, this call itself) — read it back scoped.
    return tx.leaveBalance.findFirstOrThrow({
      where: { organizationId, employeeId, leaveTypeId, year },
    });
  }

  // Reconciles the current year's EXISTING balance rows for a leave type with its upfront rule (Annual Quota, prorated
  // for someone who joined this year), so a quota or Prorate-on-Joining edit reaches everyone who already has a row.
  // `credited` is SET to the upfront figure (never incremented), so re-running gives the same result. It never drops
  // below what has already been taken, encashed or is held by pending requests, so closing cannot turn negative.
  // With dryRun nothing is written: the same list of changes is returned for a preview. Run it inside the same
  // transaction as the leave-type update.
  async reconcileUpfrontCredit(
    tx: Prisma.TransactionClient,
    updated: LeaveType,
    organizationId: string,
    options: { dryRun?: boolean } = {},
  ): Promise<{
    rowsUpdated: number;
    changes: {
      employeeId: string;
      employeeCode: string;
      name: string;
      from: number;
      to: number;
    }[];
  }> {
    // Only quota types have an upfront credit; Unlimited / None (e.g. Comp-Off) are credited by other means and
    // must never be reset here.
    if (
      updated.allocationType !== AllocationType.FIXED_ANNUAL &&
      updated.allocationType !== AllocationType.PRORATED_ON_JOINING &&
      updated.allocationType !== AllocationType.EARNED_MONTHLY
    ) {
      return { rowsUpdated: 0, changes: [] };
    }
    const year = new Date().getFullYear();
    const rows = await tx.leaveBalance.findMany({
      where: { organizationId, leaveTypeId: updated.id, year },
    });
    if (rows.length === 0) return { rowsUpdated: 0, changes: [] };

    const employees = await tx.user.findMany({
      where: { organizationId, id: { in: rows.map((r) => r.employeeId) } },
      select: { id: true, joiningDate: true, name: true, employeeId: true },
    });
    const byId = new Map(employees.map((e) => [e.id, e]));

    const changes: {
      employeeId: string;
      employeeCode: string;
      name: string;
      from: number;
      to: number;
    }[] = [];
    for (const row of rows) {
      const employee = byId.get(row.employeeId);
      if (!employee) continue;
      const upfront = computeUpfrontCredit(updated, employee.joiningDate, year);
      const floor = Math.max(
        0,
        row.availed + row.encashed + row.pending - row.opening - row.adjusted,
      );
      const credited = Math.round(Math.max(upfront, floor) * 100) / 100;
      if (credited === row.credited && row.lastAccrualPeriod === null) continue;
      changes.push({
        employeeId: row.employeeId,
        employeeCode: employee.employeeId,
        name: employee.name,
        from: row.credited,
        to: credited,
      });
      if (options.dryRun) continue;
      await tx.leaveBalance.updateMany({
        where: { id: row.id, organizationId },
        data: {
          credited,
          closing: recalcClosing({ ...row, credited }),
          lastAccrualPeriod: null,
        },
      });
    }
    return { rowsUpdated: options.dryRun ? 0 : changes.length, changes };
  }


  // Recomputes and persists `closing` for a balance row — the single
  // source-of-truth writer, mirroring recalculateLeaveBalance. Called after
  // every mutation to opening/credited/availed/encashed/adjusted.
  //
  // Uses updateMany (not update) — LeaveBalance is tenant-scoped, and the
  // guard forbids update()'s unique-only where outright (see
  // tenant-scope.guard-logic.ts). updateMany's where can be
  // organizationId-scoped directly.
  async recalculate(
    tx: Prisma.TransactionClient,
    balanceId: string,
    organizationId: string,
  ): Promise<LeaveBalance> {
    const row = await tx.leaveBalance.findFirstOrThrow({
      where: { id: balanceId, organizationId },
    });
    await tx.leaveBalance.updateMany({
      where: { id: balanceId, organizationId },
      data: { closing: recalcClosing(row) },
    });
    return tx.leaveBalance.findFirstOrThrow({
      where: { id: balanceId, organizationId },
    });
  }

  /**
   * Carried-in days that lapsed unused, per balance row id, as of `asOf` (YYYY-MM-DD). Only rows whose carried-in
   * balance has expired appear in the result (everything else is 0). The days leave took from the carried-in pool
   * before it expired are spent, not lost, so they are worked out from the employee's approved leave (oldest days
   * first): lapsed = carried-in opening − min(opening, approved leave taken before the expiry date). One query for
   * all the rows, and none at all when nothing has expired.
   */
  async forfeitedCarryIn(
    db: Pick<Prisma.TransactionClient, 'leave'>,
    rows: Pick<
      LeaveBalance,
      | 'id'
      | 'employeeId'
      | 'leaveTypeId'
      | 'year'
      | 'opening'
      | 'carriedInExpiresOn'
    >[],
    organizationId: string,
    asOf: string,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const expired = rows.filter(
      (r) => r.opening > 0 && isCarriedInExpired(r.carriedInExpiresOn, asOf),
    );
    if (expired.length === 0) return result;

    const years = expired.map((r) => r.year);
    const leaves = await db.leave.findMany({
      where: {
        organizationId,
        status: LeaveStatus.APPROVED,
        employeeId: { in: [...new Set(expired.map((r) => r.employeeId))] },
        leaveTypeId: { in: [...new Set(expired.map((r) => r.leaveTypeId))] },
        startDate: {
          gte: `${Math.min(...years)}-01-01`,
          lte: `${Math.max(...years)}-12-31`,
        },
      },
      select: {
        employeeId: true,
        leaveTypeId: true,
        startDate: true,
        endDate: true,
        totalDays: true,
      },
    });
    for (const row of expired) {
      const taken = availedBeforeExpiry(
        leaves.filter(
          (l) =>
            l.employeeId === row.employeeId &&
            l.leaveTypeId === row.leaveTypeId &&
            l.startDate.startsWith(`${row.year}-`),
        ),
        row.carriedInExpiresOn as string,
      );
      const lapsed = forfeitedCarryIn(row.opening, taken, true);
      if (lapsed > 0) result.set(row.id, lapsed);
    }
    return result;
  }

  async getEligibleLeaveTypes(
    employeeId: string,
    organizationId: string,
  ): Promise<LeaveType[]> {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
    });
    if (!employee) throw new NotFoundException('Employee not found.');

    // Same ordering as LeaveTypesService.findAll() (the HR-facing Leave
    // Types list) — without this, the order employees see their leave
    // balance cards in (My Leave, the employee dashboard) was whatever
    // order Postgres happened to return rows in, not anything deliberate.
    const leaveTypes = await this.scopedPrisma.leaveType.findMany({
      where: { organizationId, isActive: true },
      orderBy: { displayOrder: 'asc' },
    });

    return leaveTypes.filter((lt) => isEligible(lt, employee));
  }

  // HR-triggered year-end rollover across every leave type with
  // carryForward.allowed, org-wide. `year` is the closing year being
  // rolled FROM (e.g. run with 2026 to carry 2026's unused balance into
  // each employee's 2027 opening).
  async runYearEndCarryForward(
    year: number,
    organizationId: string,
  ): Promise<{ processed: number; disabledByOrg?: boolean }> {
    // Company-wide switch (Organization Settings → Policies) overrides every
    // leave type's own Carry Forward setting while it's off.
    const { allowCarryForward } = await getOrgLeaveSwitches(
      this.scopedPrisma,
      organizationId,
    );
    if (!allowCarryForward) return { processed: 0, disabledByOrg: true };

    const leaveTypes = await this.scopedPrisma.leaveType.findMany({
      where: { organizationId, isActive: true },
    });
    const carryForwardTypes = leaveTypes.filter(
      (lt) => (lt.carryForward as unknown as CarryForwardShape).allowed,
    );

    // Batched outside the transaction, same rationale as seedBalancesForNewType —
    // the closing-year rows for every carry-forward-enabled leave type in
    // one query, and whichever of their employees already have a
    // next-year row in one more, instead of a findMany + a per-row
    // existence read all inside the held transaction.
    const carryForwardTypeIds = carryForwardTypes.map((lt) => lt.id);
    const closingRows = await this.scopedPrisma.leaveBalance.findMany({
      where: {
        organizationId,
        leaveTypeId: { in: carryForwardTypeIds },
        year,
      },
    });
    const nextYearRows = await this.scopedPrisma.leaveBalance.findMany({
      where: {
        organizationId,
        leaveTypeId: { in: carryForwardTypeIds },
        year: year + 1,
        employeeId: { in: closingRows.map((r) => r.employeeId) },
      },
    });
    const nextYearByKey = new Map(
      nextYearRows.map((r) => [`${r.employeeId}:${r.leaveTypeId}`, r]),
    );
    const rowsByLeaveTypeId = new Map<string, typeof closingRows>();
    for (const row of closingRows) {
      const list = rowsByLeaveTypeId.get(row.leaveTypeId) ?? [];
      list.push(row);
      rowsByLeaveTypeId.set(row.leaveTypeId, list);
    }

    // Carry-forward happens at the turn of the year, so a balance carried INTO the closing year is judged as of that
    // moment (1 Jan of the next year). Carried-in days that lapsed unused by then — the usual case for a 12-month
    // expiry, whose date is exactly that 1 Jan — are not carried a second time with a fresh expiry.
    const lapsedByRow = await this.forfeitedCarryIn(
      this.scopedPrisma,
      closingRows,
      organizationId,
      `${year + 1}-01-01`,
    );

    let processed = 0;
    await this.scopedPrisma.$transaction(async (tx) => {
      for (const leaveType of carryForwardTypes) {
        const cf = leaveType.carryForward as unknown as CarryForwardShape;
        const rows = rowsByLeaveTypeId.get(leaveType.id) ?? [];

        for (const row of rows) {
          const carryOut = computeCarryOut(
            row.closing - (lapsedByRow.get(row.id) ?? 0),
            cf.maxDays,
          );
          await tx.leaveBalance.updateMany({
            where: { id: row.id, organizationId },
            data: { carriedForwardOut: carryOut },
          });

          const nextRow =
            nextYearByKey.get(`${row.employeeId}:${leaveType.id}`) ??
            (await this.ensureBalanceRow(
              tx,
              row.employeeId,
              leaveType.id,
              year + 1,
              organizationId,
            ));
          await tx.leaveBalance.updateMany({
            where: { id: nextRow.id, organizationId },
            data: {
              opening: carryOut,
              carriedInExpiresOn: computeCarriedInExpiry(
                year + 1,
                cf.expiryMonths,
              ),
            },
          });
          await this.recalculate(tx, nextRow.id, organizationId);
          processed += 1;
        }
      }
    });

    return { processed };
  }
}
