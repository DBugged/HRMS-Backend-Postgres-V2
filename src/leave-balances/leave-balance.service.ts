// Purpose: Owns the leave-balance ledger — get-or-create per (employee, leaveType, year), the single
// recalculate() writer for `closing`, accrual crediting, and year-end carry-forward.
// Responsibilities: Wraps the pure math in leave-eligibility.ts/leave-balance-math.ts with the actual DB
// reads/writes; exposed cross-module (e.g. to LeaveEncashmentsService, LeaveTypesService) as the one place
// balance mutations happen, mirroring the old backend's leavePolicyEngine.js.
// Important: ensureBalanceRow()/recalculate() must be called with a transaction client so the
// read-then-maybe-create/read-then-write is atomic under concurrent callers. creditAccrual() is
// idempotent per accrual period (a row already on the current period is skipped, not re-credited),
// backfills every cycle missed since a row's last credit (countElapsedCycles), and backdates a row's very
// first-ever credit to the employee's joining cycle (cyclesSinceJoining) rather than only the current one.
import { randomUUID } from 'crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  AllocationType,
  LeaveBalance,
  LeaveType,
  Prisma,
  Role,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { isEligible } from './leave-eligibility';
import { getOrgLeaveSwitches } from '../organizations/org-leave-switches';
import {
  accrualCreditPerCycle,
  accruesPerCycle,
  computeAccrualPeriodKey,
  computeCarriedInExpiry,
  computeCarryOut,
  computeUpfrontCredit,
  countElapsedCycles,
  cyclesSinceJoining,
  expectedAccrualToDate,
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
   * The opening/credited/lastAccrualPeriod a brand-new balance row starts with. Shared by
   * ensureBalanceRow (one row) and ensureBalanceRowsBulk (many) so both always agree.
   */
  private initialBalanceFor(
    joiningDate: Date,
    leaveType: LeaveType,
    year: number,
    priorYearRow: { carriedForwardOut: number } | null | undefined,
  ) {
    const opening = priorYearRow?.carriedForwardOut ?? 0;
    let credited = computeUpfrontCredit(leaveType, joiningDate, year);
    let lastAccrualPeriod: string | null = null;

    // Per-cycle types (Quarterly, Monthly, ...): credit every cycle due so
    // far right away — from the joining cycle (or Jan 1) through the current
    // one — so a new joiner sees their balance immediately instead of 0
    // until the next Run Accrual. Stamping the current period means that run
    // only adds cycles that start after today. Current year only, and not
    // for someone whose joining date is still in the future.
    const now = new Date();
    if (
      accruesPerCycle(leaveType) &&
      year === now.getFullYear() &&
      joiningDate <= now
    ) {
      const yearStart = new Date(Date.UTC(year, 0, 1));
      const cycles = cyclesSinceJoining(
        leaveType.accrualFrequency,
        joiningDate > yearStart ? joiningDate : yearStart,
        now,
      );
      credited =
        Math.round(accrualCreditPerCycle(leaveType) * cycles * 100) / 100;
      lastAccrualPeriod = computeAccrualPeriodKey(
        leaveType.accrualFrequency,
        now,
      );
    }

    return { opening, credited, lastAccrualPeriod };
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

  // Reconciles the current year's EXISTING balance rows for a leave type
  // after an upfront-relevant field (annualQuota / allocationType /
  // accrualFrequency / prorateOnJoining) is edited — ensureBalanceRow only computes the upfront
  // credit when a row is first created, so without this a quota change never
  // reached anyone who already had a row. Must run inside the same
  // transaction as the leave-type update.
  //
  // Idempotent: `credited` is SET to computeUpfrontCredit(newType) (plus any
  // accrual already credited on top of the old upfront amount, when the type
  // accrues), never incremented by the new quota — re-running with the same
  // quota writes the same value.
  async reconcileUpfrontCredit(
    tx: Prisma.TransactionClient,
    previous: LeaveType,
    updated: LeaveType,
    organizationId: string,
  ): Promise<{ rowsUpdated: number }> {
    // Deliberately no early return for "updated isn't an upfront type"
    // anymore — that used to skip this whole function whenever Allocation
    // Type was changed AWAY FROM Fixed Annual/Prorated on Joining (e.g. to
    // Earned Monthly), leaving that old upfront grant permanently stuck in
    // `credited`. Every later creditAccrual run then added fresh accrual on
    // top of it, so the balance was inflated forever by whatever the
    // employee had already been granted under the old policy. The formula
    // below already handles "updated has no upfront credit" correctly
    // (computeUpfrontCredit returns 0 for it) — it only needed to actually
    // run.
    const year = new Date().getFullYear();
    const rows = await tx.leaveBalance.findMany({
      where: { organizationId, leaveTypeId: updated.id, year },
    });
    if (rows.length === 0) return { rowsUpdated: 0 };

    const employees = await tx.user.findMany({
      where: { organizationId, id: { in: rows.map((r) => r.employeeId) } },
      select: { id: true, joiningDate: true },
    });
    const joiningById = new Map(employees.map((e) => [e.id, e.joiningDate]));

    const previousAccrues = accruesPerCycle(previous);
    const updatedAccrues = accruesPerCycle(updated);

    let rowsUpdated = 0;
    for (const row of rows) {
      const joiningDate = joiningById.get(row.employeeId);
      if (!joiningDate) continue;
      const newUpfront = computeUpfrontCredit(updated, joiningDate, year);
      let credited: number;
      // undefined = leave lastAccrualPeriod as is.
      let lastAccrualPeriod: string | null | undefined;
      if (previousAccrues && !updatedAccrues) {
        // Per-cycle → Yearly: the full upfront grant replaces whatever was
        // accrued so far this year (it already covers those cycles).
        credited = newUpfront;
      } else if (!previousAccrues && updatedAccrues) {
        // Yearly → per-cycle: take back the upfront grant and credit every
        // cycle due so far instead (since Jan 1 / joining, same as a new
        // balance row), so the year isn't credited twice (6 upfront +
        // 4 × 1.5) and nobody sits at 0 until the next Run Accrual.
        const now = new Date();
        const yearStart = new Date(Date.UTC(year, 0, 1));
        const due =
          joiningDate <= now
            ? accrualCreditPerCycle(updated) *
              cyclesSinceJoining(
                updated.accrualFrequency,
                joiningDate > yearStart ? joiningDate : yearStart,
                now,
              )
            : 0;
        credited =
          Math.max(
            0,
            row.credited - computeUpfrontCredit(previous, joiningDate, year),
          ) + due;
        lastAccrualPeriod =
          joiningDate <= now
            ? computeAccrualPeriodKey(updated.accrualFrequency, now)
            : null;
      } else {
        // Same mode as before: preserve days credited by accrual runs on top
        // of the upfront grant; otherwise the row's credited is purely the
        // upfront amount and is set outright, which also repairs rows left
        // stale by earlier quota edits.
        const accruedOnTop =
          updated.accrualAmountPerCycle > 0 ||
          previous.accrualAmountPerCycle > 0
            ? Math.max(
                0,
                row.credited -
                  computeUpfrontCredit(previous, joiningDate, year),
              )
            : 0;
        credited = newUpfront + accruedOnTop;
      }
      credited = Math.round(credited * 100) / 100;
      if (
        credited === row.credited &&
        (lastAccrualPeriod === undefined ||
          lastAccrualPeriod === row.lastAccrualPeriod)
      ) {
        continue;
      }
      await tx.leaveBalance.updateMany({
        where: { id: row.id, organizationId },
        data: {
          credited,
          closing: recalcClosing({ ...row, credited }),
          ...(lastAccrualPeriod !== undefined && { lastAccrualPeriod }),
        },
      });
      rowsUpdated += 1;
    }
    return { rowsUpdated };
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

  // HR-triggered, on-demand (no cron infra, same as the old system) —
  // credits accrualAmountPerCycle to every currently-eligible employee's
  // current-year balance for this leave type. Idempotent per accrual
  // period (see computeAccrualPeriodKey): an employee whose row's
  // lastAccrualPeriod already matches the current cycle is skipped
  // instead of re-credited — a double-click (or an HR admin re-running it
  // "just in case") no longer silently double-credits, unlike the old
  // system this was originally ported from as-is.
  async creditAccrual(
    leaveTypeId: string,
    organizationId: string,
  ): Promise<{
    matched: number;
    credited: number;
    alreadyAccrued: number;
    // Of the already-accrued employees, how many hold less than they should have by now (see checkAccrual).
    behind: number;
    totalDaysCredited: number;
  }> {
    const leaveType = await this.scopedPrisma.leaveType.findFirst({
      where: { id: leaveTypeId, organizationId },
    });
    if (!leaveType) throw new NotFoundException('Leave type not found.');

    // Yearly Fixed Annual / Prorated types already got the whole quota
    // upfront (ensureBalanceRow) — crediting a cycle on top would double it
    // (6 upfront + 4 × 1.5 = 12). See accruesPerCycle.
    if (!accruesPerCycle(leaveType)) {
      return {
        matched: 0,
        credited: 0,
        alreadyAccrued: 0,
        behind: 0,
        totalDaysCredited: 0,
      };
    }

    const year = new Date().getFullYear();
    const employees = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        role: { in: ACCRUAL_ELIGIBLE_ROLES },
      },
    });
    // Someone whose joining date is still in the future has earned nothing
    // yet — cyclesSinceJoining falls back to 1 cycle for that case, which
    // used to credit them a cycle before they'd even started. They're picked
    // up by the first run on/after their joining date (or straight away when
    // their balance row is first created after joining).
    const now = new Date();
    const eligible = employees.filter(
      (e) => e.joiningDate <= now && isEligible(leaveType, e),
    );

    // Batched outside the transaction: which of these employees already
    // have a current-year row, so the loop below can skip
    // ensureBalanceRow's own existence read for the common case (already
    // exists) instead of doing it per employee inside the held
    // transaction — was up to ~8 queries/employee inside one long
    // transaction, this cuts the read side to a single findMany upfront.
    const existingRows = await this.scopedPrisma.leaveBalance.findMany({
      where: {
        organizationId,
        leaveTypeId,
        year,
        employeeId: { in: eligible.map((e) => e.id) },
      },
    });
    const existingByEmployeeId = new Map(
      existingRows.map((r) => [r.employeeId, r]),
    );

    const periodKey = computeAccrualPeriodKey(
      leaveType.accrualFrequency,
      new Date(),
    );
    const perCycle = accrualCreditPerCycle(leaveType);
    // creditAccrual only ever writes into `year`'s balance row — it never
    // touches a prior year's row, and carrying a balance across years is a
    // separate, explicit process (runYearEndCarryForward) gated by the
    // leave type's own carryForward.allowed. So a first-ever credit must
    // never backdate past Jan 1 of `year`, even for an employee who joined
    // in an earlier year — those earlier cycles belong to (and, unless
    // carry-forward is on, expire with) that earlier year's own row, which
    // this call was never asked to touch.
    const yearStart = new Date(Date.UTC(year, 0, 1));
    let credited = 0;
    let alreadyAccrued = 0;
    let behind = 0;
    let totalDaysCredited = 0;

    await this.scopedPrisma.$transaction(async (tx) => {
      for (const employee of eligible) {
        const row =
          existingByEmployeeId.get(employee.id) ??
          (await this.ensureBalanceRow(
            tx,
            employee.id,
            leaveTypeId,
            year,
            organizationId,
          ));

        if (row.lastAccrualPeriod === periodKey) {
          alreadyAccrued += 1;
          // Stamped for this period but holding less than is due: the run cannot tell, so it is flagged for
          // checkAccrual/repairAccrual instead of being reported as simply "up to date".
          if (
            row.credited + 0.005 <
            expectedAccrualToDate(leaveType, employee.joiningDate, year, now)
          ) {
            behind += 1;
          }
          continue;
        }

        // Backfill every cycle missed since this row's last credit (e.g.
        // the accrual cron's host was down across one or more cycle
        // boundaries), not just the latest one. A row credited for the
        // first time ever (lastAccrualPeriod null) backdates instead to
        // the employee's joining cycle within *this* year — their true
        // entitlement since they joined (or since Jan 1, whichever is
        // later, since a prior year is a different row entirely — see
        // yearStart above) — not just from whenever accrual first
        // happened to run for them.
        const cycles = row.lastAccrualPeriod
          ? countElapsedCycles(
              leaveType.accrualFrequency,
              row.lastAccrualPeriod,
              periodKey,
            )
          : cyclesSinceJoining(
              leaveType.accrualFrequency,
              employee.joiningDate > yearStart
                ? employee.joiningDate
                : yearStart,
              new Date(),
            );

        // Atomic increment, not `row.credited + delta` — a JS-computed value read before the
        // transaction would lose a concurrent run's credit. The check above makes a *later* call for
        // the same period a no-op; the compare-and-swap on lastAccrualPeriod below makes two
        // genuinely concurrent calls safe.
        // A Fixed Annual / Prorated row's first-ever accrual only tops it up
        // to what's due so far: rows created before accrual followed
        // Accrual Frequency were already granted the whole quota upfront
        // (6 for a Quarterly EL), and adding 4 × 1.5 on top would double
        // it. Rows created since start at 0, so this is just perCycle ×
        // cycles for them.
        const due = perCycle * cycles;
        const daysCredited =
          !row.lastAccrualPeriod &&
          leaveType.allocationType !== AllocationType.EARNED_MONTHLY
            ? Math.max(0, Math.round((due - row.credited) * 100) / 100)
            : due;
        // Claim the period with a compare-and-swap on the stamp this run read: the UPDATE only matches while the
        // row still holds that same lastAccrualPeriod. `row` comes from a read made before this transaction, so
        // two overlapping runs (two admins, a double-click, the 02:00 cron plus a manual run) both start from the
        // same stale stamp; the first UPDATE changes it, and the second finds 0 rows and credits nothing instead
        // of adding the same cycles again.
        const claimed = await tx.leaveBalance.updateMany({
          where: {
            id: row.id,
            organizationId,
            lastAccrualPeriod: row.lastAccrualPeriod,
          },
          data: {
            credited: {
              increment: daysCredited,
            },
            lastAccrualPeriod: periodKey,
          },
        });
        if (claimed.count === 0) {
          alreadyAccrued += 1;
          continue;
        }
        await this.recalculate(tx, row.id, organizationId);
        credited += 1;
        totalDaysCredited += daysCredited;
      }
    });

    // `credited` counts employees processed (row stamped for this period),
    // NOT days — totalDaysCredited is the real amount, and is 0 whenever
    // accrualAmountPerCycle is 0 (the default for every FIXED_ANNUAL type).
    return {
      matched: eligible.length,
      credited,
      alreadyAccrued,
      behind,
      totalDaysCredited: Math.round(totalDaysCredited * 100) / 100,
    };
  }

  // Compares each eligible employee's current-year credit with what the leave type's own rule says they should
  // have by now (expectedAccrualToDate). Read-only. Only rows already stamped for the current period are
  // repairable: an older or empty stamp means the normal Run Accrual still owes those cycles and will credit them
  // (repairing those too would credit them twice), so they are reported as PENDING_RUN. A row holding MORE than
  // expected (e.g. a whole quota granted upfront before the type switched to Quarterly) is reported as OVER and never
  // reduced.
  async checkAccrual(leaveTypeId: string, organizationId: string) {
    const leaveType = await this.scopedPrisma.leaveType.findFirst({
      where: { id: leaveTypeId, organizationId },
    });
    if (!leaveType) throw new NotFoundException('Leave type not found.');
    const year = new Date().getFullYear();
    const now = new Date();
    const periodKey = computeAccrualPeriodKey(leaveType.accrualFrequency, now);

    if (!accruesPerCycle(leaveType)) {
      return {
        leaveType: {
          id: leaveType.id,
          name: leaveType.name,
          code: leaveType.code,
        },
        year,
        period: periodKey,
        perCycle: 0,
        rows: [],
        summary: { short: 0, pendingRun: 0, over: 0, ok: 0, daysShort: 0 },
        note: 'This leave type is granted upfront or not accrued, so there is nothing to check.',
      };
    }

    const employees = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        role: { in: ACCRUAL_ELIGIBLE_ROLES },
      },
      select: {
        id: true,
        name: true,
        employeeId: true,
        joiningDate: true,
        departmentId: true,
        employeeType: true,
        gender: true,
      },
    });
    const eligible = employees.filter(
      (e) => e.joiningDate <= now && isEligible(leaveType, e),
    );
    const existing = await this.scopedPrisma.leaveBalance.findMany({
      where: {
        organizationId,
        leaveTypeId,
        year,
        employeeId: { in: eligible.map((e) => e.id) },
      },
    });
    const byEmployee = new Map(existing.map((r) => [r.employeeId, r]));

    const rows = eligible.flatMap((e) => {
      const row = byEmployee.get(e.id);
      // No row yet: the first Run Accrual (or opening My Leave) creates it with everything due.
      if (!row) return [];
      const expected = expectedAccrualToDate(
        leaveType,
        e.joiningDate,
        year,
        now,
      );
      const difference = Math.round((expected - row.credited) * 100) / 100;
      const status: 'SHORT' | 'PENDING_RUN' | 'OVER' | 'OK' =
        difference > 0.005
          ? row.lastAccrualPeriod === periodKey
            ? 'SHORT'
            : 'PENDING_RUN'
          : difference < -0.005
            ? 'OVER'
            : 'OK';
      return [
        {
          balanceId: row.id,
          employeeId: e.id,
          employeeCode: e.employeeId,
          employeeName: e.name,
          joiningDate: e.joiningDate.toISOString().slice(0, 10),
          lastAccrualPeriod: row.lastAccrualPeriod,
          current: row.credited,
          expected,
          difference,
          status,
          availed: row.availed,
        },
      ];
    });
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    return {
      leaveType: {
        id: leaveType.id,
        name: leaveType.name,
        code: leaveType.code,
      },
      year,
      period: periodKey,
      perCycle: accrualCreditPerCycle(leaveType),
      // Only the problem rows are returned, so the report stays readable for large organizations.
      rows: rows.filter((r) => r.status !== 'OK'),
      summary: {
        short: count('SHORT'),
        pendingRun: count('PENDING_RUN'),
        over: count('OVER'),
        ok: count('OK'),
        daysShort:
          Math.round(
            rows
              .filter((r) => r.status === 'SHORT')
              .reduce((sum, r) => sum + r.difference, 0) * 100,
          ) / 100,
      },
    };
  }

  // Credits the missing days for the SHORT rows from checkAccrual — and only those. Adds the difference (never sets
  // the balance to the expected figure), guarded per row by a compare-and-swap on the credited amount the check saw, so
  // a row that changed in the meantime is skipped rather than overwritten. Returns what was applied for the audit log.
  async repairAccrual(leaveTypeId: string, organizationId: string) {
    const check = await this.checkAccrual(leaveTypeId, organizationId);
    const short = check.rows.filter((r) => r.status === 'SHORT');
    const applied: {
      employeeId: string;
      employeeCode: string;
      before: number;
      added: number;
    }[] = [];
    let skipped = 0;
    await this.scopedPrisma.$transaction(async (tx) => {
      for (const r of short) {
        const claimed = await tx.leaveBalance.updateMany({
          where: {
            id: r.balanceId,
            organizationId,
            credited: r.current,
            lastAccrualPeriod: r.lastAccrualPeriod,
          },
          data: { credited: { increment: r.difference } },
        });
        if (claimed.count === 0) {
          skipped += 1;
          continue;
        }
        await this.recalculate(tx, r.balanceId, organizationId);
        applied.push({
          employeeId: r.employeeId,
          employeeCode: r.employeeCode,
          before: r.current,
          added: r.difference,
        });
      }
    });
    return {
      leaveType: check.leaveType,
      year: check.year,
      period: check.period,
      repaired: applied.length,
      skipped,
      totalDaysAdded:
        Math.round(applied.reduce((sum, a) => sum + a.added, 0) * 100) / 100,
      applied,
    };
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

    // Batched outside the transaction, same rationale as creditAccrual —
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

    let processed = 0;
    await this.scopedPrisma.$transaction(async (tx) => {
      for (const leaveType of carryForwardTypes) {
        const cf = leaveType.carryForward as unknown as CarryForwardShape;
        const rows = rowsByLeaveTypeId.get(leaveType.id) ?? [];

        for (const row of rows) {
          const carryOut = computeCarryOut(row.closing, cf.maxDays);
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
