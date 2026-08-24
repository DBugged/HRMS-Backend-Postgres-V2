// Purpose: Owns the leave-balance ledger — get-or-create per (employee, leaveType, year), the single
// recalculate() writer for `closing`, accrual crediting, and year-end carry-forward.
// Responsibilities: Wraps the pure math in leave-eligibility.ts/leave-balance-math.ts with the actual DB
// reads/writes; exposed cross-module (e.g. to LeaveEncashmentsService, LeaveTypesService) as the one place
// balance mutations happen, mirroring the old backend's leavePolicyEngine.js.
// Important: ensureBalanceRow()/recalculate() must be called with a transaction client so the
// read-then-maybe-create/read-then-write is atomic under concurrent callers. creditAccrual() has no
// frequency gating or idempotency guard — calling it twice in the same period double-credits, ported as-is
// from the old system.
import { randomUUID } from 'crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { LeaveBalance, LeaveType, Prisma, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { isEligible } from './leave-eligibility';
import {
  computeCarriedInExpiry,
  computeCarryOut,
  computeUpfrontCredit,
  recalcClosing,
} from './leave-balance-math';

interface CarryForwardShape {
  allowed: boolean;
  maxDays: number;
  expiryMonths: number | null;
}

// Roles eligible for leave accrual/balance tracking — old system's
// 'employee'/'department_head' → backend-v2's EMPLOYEE/MANAGER, per the
// established role-mapping table (administrator→ADMIN, hr_admin→HR).
const ACCRUAL_ELIGIBLE_ROLES: Role[] = [Role.EMPLOYEE, Role.MANAGER];

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

    const opening = priorYearRow?.carriedForwardOut ?? 0;
    const credited = computeUpfrontCredit(
      leaveType,
      employee.joiningDate,
      year,
    );

    await tx.$executeRaw`
      INSERT INTO leave_balances
        (id, "organizationId", "employeeId", "leaveTypeId", "year", "opening", "credited", "closing", "createdAt", "updatedAt")
      VALUES
        (${randomUUID()}, ${organizationId}, ${employeeId}, ${leaveTypeId}, ${year}, ${opening}, ${credited}, ${opening + credited}, now(), now())
      ON CONFLICT ("organizationId", "employeeId", "leaveTypeId", "year") DO NOTHING
    `;

    // Whichever of this call and its concurrent racers actually inserted
    // (or, on the no-race path, this call itself) — read it back scoped.
    return tx.leaveBalance.findFirstOrThrow({
      where: { organizationId, employeeId, leaveTypeId, year },
    });
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

    const leaveTypes = await this.scopedPrisma.leaveType.findMany({
      where: { organizationId, isActive: true },
    });

    return leaveTypes.filter((lt) => isEligible(lt, employee));
  }

  // HR-triggered, on-demand (no cron infra, same as the old system) —
  // credits accrualAmountPerCycle to every currently-eligible EMPLOYEE/
  // MANAGER's current-year balance for this leave type. No frequency
  // gating or idempotency guard, ported as-is: calling this twice in the
  // same period double-credits, exactly like the old backend.
  async creditAccrual(
    leaveTypeId: string,
    organizationId: string,
  ): Promise<{ matched: number }> {
    const leaveType = await this.scopedPrisma.leaveType.findFirst({
      where: { id: leaveTypeId, organizationId },
    });
    if (!leaveType) throw new NotFoundException('Leave type not found.');

    const year = new Date().getFullYear();
    const employees = await this.scopedPrisma.user.findMany({
      where: {
        organizationId,
        isActive: true,
        role: { in: ACCRUAL_ELIGIBLE_ROLES },
      },
    });
    const eligible = employees.filter((e) => isEligible(leaveType, e));

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
        await tx.leaveBalance.updateMany({
          where: { id: row.id, organizationId },
          data: { credited: row.credited + leaveType.accrualAmountPerCycle },
        });
        await this.recalculate(tx, row.id, organizationId);
      }
    });

    return { matched: eligible.length };
  }

  // HR-triggered year-end rollover across every leave type with
  // carryForward.allowed, org-wide. `year` is the closing year being
  // rolled FROM (e.g. run with 2026 to carry 2026's unused balance into
  // each employee's 2027 opening).
  async runYearEndCarryForward(
    year: number,
    organizationId: string,
  ): Promise<{ processed: number }> {
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
