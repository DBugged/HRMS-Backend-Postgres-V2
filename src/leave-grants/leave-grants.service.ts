// Purpose: Grants event-based leave (maternity, paternity, adoption...) to one employee for one qualifying event, and
//   reverses a grant that was wrong. The granted days are credited to the employee's LeaveBalance for the year the
//   grant takes effect, so applying, approving, cancelling and balance reporting work exactly as for any other type.
// Important: Grants are manual HR/Admin actions - nothing here detects childbirth or adoption. A correction is a
//   reversal (status REVERSED, who/when/why), never a delete. Repeats are blocked by a partial unique index
//   (one ACTIVE grant per employee, leave type and event date) and by the optional idempotency key, so retries and
//   concurrent requests cannot grant twice.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role, type LeaveGrant, type User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { LeaveBalanceService } from '../leave-balances/leave-balance.service';
import { isEligible } from '../leave-balances/leave-eligibility';
import { AuditLogService } from '../audit-log/audit-log.service';
import { checkGrantRequest } from './leave-grant-rules';
import {
  CreateLeaveGrantDto,
  QueryLeaveGrantsDto,
  ReverseLeaveGrantDto,
} from './dto/leave-grant.dto';

type Caller = Omit<User, 'password'>;

@Injectable()
export class LeaveGrantsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly balances: LeaveBalanceService,
    private readonly auditLog: AuditLogService,
  ) {}

  async list(
    query: QueryLeaveGrantsDto,
    caller: Caller,
    organizationId: string,
  ) {
    const isHr = caller.role === Role.ADMIN || caller.role === Role.HR;
    // Everyone else sees only their own grants.
    const employeeId = isHr ? query.employeeId : caller.id;
    return this.scopedPrisma.leaveGrant.findMany({
      where: {
        organizationId,
        ...(employeeId && { employeeId }),
        ...(query.leaveTypeId && { leaveTypeId: query.leaveTypeId }),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        leaveType: { select: { id: true, name: true, code: true } },
        employee: { select: { id: true, name: true, employeeId: true } },
        grantedBy: { select: { id: true, name: true } },
        reversedBy: { select: { id: true, name: true } },
      },
    });
  }

  async grant(
    dto: CreateLeaveGrantDto,
    caller: Caller,
    organizationId: string,
  ) {
    // HR cannot grant leave to themselves; an Admin can (the grant is audit-logged with the same actor and target).
    if (caller.id === dto.employeeId && caller.role !== Role.ADMIN) {
      throw new ForbiddenException(
        'You cannot grant leave to yourself. Ask another HR or Admin user.',
      );
    }
    const [leaveType, employee] = await Promise.all([
      this.scopedPrisma.leaveType.findFirst({
        where: { id: dto.leaveTypeId, organizationId },
      }),
      this.scopedPrisma.user.findFirst({
        where: { id: dto.employeeId, organizationId },
        select: {
          id: true,
          isActive: true,
          joiningDate: true,
          departmentId: true,
          employeeType: true,
          gender: true,
        },
      }),
    ]);
    if (!leaveType) throw new NotFoundException('Leave type not found.');
    if (!employee) throw new NotFoundException('Employee not found.');
    if (!employee.isActive) {
      throw new BadRequestException('This employee is not active.');
    }
    const effectiveDate = dto.effectiveDate ?? dto.eventDate;
    if (
      !isEligible(leaveType, employee, new Date(`${effectiveDate}T00:00:00Z`))
    ) {
      throw new BadRequestException(
        'This employee does not meet the eligibility rules of this leave type.',
      );
    }

    // A retried request with the same key returns what was already granted.
    if (dto.idempotencyKey) {
      const prior = await this.scopedPrisma.leaveGrant.findFirst({
        where: { organizationId, idempotencyKey: dto.idempotencyKey },
      });
      if (prior) {
        if (
          prior.employeeId !== dto.employeeId ||
          prior.leaveTypeId !== dto.leaveTypeId
        ) {
          throw new ConflictException(
            'This idempotency key was used for a different grant.',
          );
        }
        return prior;
      }
    }

    const active = await this.scopedPrisma.leaveGrant.findMany({
      where: {
        organizationId,
        employeeId: dto.employeeId,
        leaveTypeId: dto.leaveTypeId,
        status: 'ACTIVE',
      },
      select: { eventDate: true },
    });
    const problem = checkGrantRequest(
      leaveType,
      {
        eventDate: dto.eventDate,
        effectiveDate,
        days: dto.days,
        documentRef: dto.documentRef,
      },
      active.map((g) => g.eventDate),
    );
    if (problem) throw new BadRequestException(problem);

    const balanceYear = Number(effectiveDate.slice(0, 4));
    let created: LeaveGrant;
    try {
      created = await this.scopedPrisma.$transaction(async (tx) => {
        const row = await this.balances.ensureBalanceRow(
          tx,
          dto.employeeId,
          dto.leaveTypeId,
          balanceYear,
          organizationId,
        );
        const grant = await tx.leaveGrant.create({
          data: {
            organizationId,
            employeeId: dto.employeeId,
            leaveTypeId: dto.leaveTypeId,
            eventDate: dto.eventDate,
            effectiveDate,
            days: dto.days,
            balanceYear,
            reason: dto.reason.trim(),
            documentRef: dto.documentRef?.trim() || null,
            idempotencyKey: dto.idempotencyKey ?? null,
            grantedById: caller.id,
          },
        });
        await this.applyDelta(
          tx,
          row.id,
          dto.employeeId,
          dto.leaveTypeId,
          balanceYear,
          dto.days,
          organizationId,
        );
        return grant;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // The unique index decided a concurrent or repeated request: the one that lost reports it.
        if (dto.idempotencyKey) {
          const prior = await this.scopedPrisma.leaveGrant.findFirst({
            where: { organizationId, idempotencyKey: dto.idempotencyKey },
          });
          if (prior) return prior;
        }
        throw new ConflictException(
          'A grant already exists for this employee, leave type and event date.',
        );
      }
      throw err;
    }

    await this.auditLog.log({
      actorId: caller.id,
      action: 'LEAVE_GRANTED',
      module: 'LEAVE',
      organizationId,
      targetId: created.id,
      details: {
        employeeId: dto.employeeId,
        leaveTypeId: dto.leaveTypeId,
        days: dto.days,
        eventDate: dto.eventDate,
        effectiveDate,
        reason: dto.reason,
        documentRef: dto.documentRef ?? null,
      },
    });
    return created;
  }

  async reverse(
    id: string,
    dto: ReverseLeaveGrantDto,
    caller: Caller,
    organizationId: string,
  ) {
    const grant = await this.scopedPrisma.leaveGrant.findFirst({
      where: { id, organizationId },
    });
    if (!grant) throw new NotFoundException('Grant not found.');
    if (grant.status === 'REVERSED') {
      throw new ConflictException('This grant was already reversed.');
    }
    if (caller.id === grant.employeeId && caller.role !== Role.ADMIN) {
      throw new ForbiddenException(
        'You cannot reverse a grant made to yourself.',
      );
    }

    await this.scopedPrisma.$transaction(async (tx) => {
      const row = await this.balances.ensureBalanceRow(
        tx,
        grant.employeeId,
        grant.leaveTypeId,
        grant.balanceYear,
        organizationId,
      );
      // Days already used (or held by a pending request) cannot be taken back by a reversal.
      if (row.closing - row.pending - grant.days < 0) {
        throw new BadRequestException(
          'Part of this grant has already been used or is held by a pending request, so it cannot be reversed. Cancel or reject those requests first.',
        );
      }
      // Only the first writer flips ACTIVE -> REVERSED, so a concurrent double reversal cannot subtract twice.
      const flipped = await tx.leaveGrant.updateMany({
        where: { id, organizationId, status: 'ACTIVE' },
        data: {
          status: 'REVERSED',
          reversedAt: new Date(),
          reversedById: caller.id,
          reversalReason: dto.reason.trim(),
        },
      });
      if (flipped.count === 0) {
        throw new ConflictException('This grant was already reversed.');
      }
      await this.applyDelta(
        tx,
        row.id,
        grant.employeeId,
        grant.leaveTypeId,
        grant.balanceYear,
        -grant.days,
        organizationId,
      );
    });

    await this.auditLog.log({
      actorId: caller.id,
      action: 'LEAVE_GRANT_REVERSED',
      module: 'LEAVE',
      organizationId,
      targetId: id,
      details: {
        employeeId: grant.employeeId,
        leaveTypeId: grant.leaveTypeId,
        days: grant.days,
        reason: dto.reason,
      },
    });
    return this.scopedPrisma.leaveGrant.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  // Credits (or takes back) `delta` days on the grant's balance row and carries the same change into any later-year
  // rows, which opened with the old closing balance, so a grant is one pool whatever the year.
  private async applyDelta(
    tx: Prisma.TransactionClient,
    rowId: string,
    employeeId: string,
    leaveTypeId: string,
    balanceYear: number,
    delta: number,
    organizationId: string,
  ) {
    await tx.leaveBalance.updateMany({
      where: { id: rowId, organizationId },
      data: { credited: { increment: delta } },
    });
    await this.balances.recalculate(tx, rowId, organizationId);
    const later = await tx.leaveBalance.findMany({
      where: {
        organizationId,
        employeeId,
        leaveTypeId,
        year: { gt: balanceYear },
      },
      select: { id: true },
    });
    for (const l of later) {
      await tx.leaveBalance.updateMany({
        where: { id: l.id, organizationId },
        data: { opening: { increment: delta } },
      });
      await this.balances.recalculate(tx, l.id, organizationId);
    }
  }
}
