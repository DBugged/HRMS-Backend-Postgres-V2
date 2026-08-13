import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Row-locked per-organization employeeId generation — mirrors the old
 * Express/Sequelize backend's utils/generateEmployeeId.js exactly, which
 * carries a comment documenting a real prior race condition: "an UPDATE
 * immediately followed by a separate unlocked SELECT is NOT safe." The fix
 * there (and here) is `SELECT ... FOR UPDATE` on the Organization row
 * inside the same transaction that creates the User row, so two concurrent
 * employee creations in the same org serialize on the lock instead of
 * both reading the same counter value and colliding.
 *
 * Deliberately simpler than the old system's generalized `documentNumbering`
 * JSON config (which covers many document types) — this phase only needs
 * one counter, stored directly as two columns on Organization.
 */
@Injectable()
export class EmployeeIdService {
  /**
   * Must be called with a transaction client (`tx` from
   * `prisma.$transaction(async (tx) => ...)`), not the plain PrismaService,
   * so the row lock and the User insert that follows are part of the same
   * transaction — locking the row and then committing/releasing before the
   * caller inserts the User would defeat the point.
   */
  async generate(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<string> {
    const rows = await tx.$queryRaw<
      { employeeIdPrefix: string; employeeIdCounter: number }[]
    >`
      SELECT "employeeIdPrefix", "employeeIdCounter" FROM organizations WHERE id = ${organizationId} FOR UPDATE
    `;
    const org = rows[0];
    if (!org) throw new Error(`Organization ${organizationId} not found`);

    const nextCounter = org.employeeIdCounter + 1;
    await tx.organization.update({
      where: { id: organizationId },
      data: { employeeIdCounter: nextCounter },
    });

    return `${org.employeeIdPrefix}-${String(nextCounter).padStart(4, '0')}`;
  }
}
