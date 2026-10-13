// Purpose: HR/Admin manual correction of one employee's leave balance (a carried-over figure from another system, a
//   wrongly credited day, a goodwill day) - the only way to change LeaveBalance.adjusted.
// Responsibilities: validates the target, applies the change to the balance row under a transaction, and writes an audit
//   entry with the reason and the before/after figures.
// Important: never takes the balance below what is already taken or held by pending requests, and nobody can adjust their
//   own balance.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AllocationType, Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { LeaveBalanceService } from './leave-balance.service';
import { getLeaveYearConfig } from './leave-year-config';
import { currentLeaveYear } from './leave-year';
import { todayInOrgTz } from '../common/org-date';
import { AdjustLeaveBalanceDto } from './dto/adjust-leave-balance.dto';

type Actor = Omit<User, 'password'>;

const ADJUSTABLE: AllocationType[] = [
  AllocationType.FIXED_ANNUAL,
  AllocationType.PRORATED_ON_JOINING,
  AllocationType.EARNED_MONTHLY,
];
const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class LeaveBalanceAdjustmentService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly leaveBalanceService: LeaveBalanceService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async adjust(
    dto: AdjustLeaveBalanceDto,
    actor: Actor,
    organizationId: string,
  ) {
    if (dto.days === 0) {
      throw new BadRequestException(
        'Enter the number of days to add or take off.',
      );
    }
    // Only an Admin may adjust their own balance (HR and everyone else need someone else); it is audited.
    if (dto.employeeId === actor.id && actor.role !== Role.ADMIN) {
      throw new ForbiddenException(
        'You cannot adjust your own leave balance. An Admin must do it.',
      );
    }
    const [employee, leaveType, org] = await Promise.all([
      this.scopedPrisma.user.findFirst({
        where: { id: dto.employeeId, organizationId },
        select: { id: true, name: true, employeeId: true },
      }),
      this.scopedPrisma.leaveType.findFirst({
        where: { id: dto.leaveTypeId, organizationId },
      }),
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { timezone: true },
      }),
    ]);
    if (!employee) throw new NotFoundException('Employee not found.');
    if (!leaveType) throw new NotFoundException('Leave type not found.');
    if (!ADJUSTABLE.includes(leaveType.allocationType)) {
      throw new BadRequestException(
        'Only yearly-quota leave types have a balance that can be adjusted (event leave is granted from Grant Event Leave).',
      );
    }
    const cfg = await getLeaveYearConfig(this.scopedPrisma, organizationId);
    const year =
      dto.year ??
      currentLeaveYear(todayInOrgTz(org?.timezone ?? 'Asia/Kolkata'), cfg);

    const result = await this.scopedPrisma.$transaction(async (tx) => {
      const row = await this.leaveBalanceService.ensureBalanceRow(
        tx,
        employee.id,
        leaveType.id,
        year,
        organizationId,
      );
      const before = row.closing;
      const after = round2(before + dto.days);
      if (after - row.pending < 0) {
        throw new BadRequestException(
          `This would take the balance to ${after} day(s), below the ${round2(row.pending)} day(s) held by pending requests. Reduce the adjustment or resolve those requests first.`,
        );
      }
      await tx.leaveBalance.updateMany({
        where: { id: row.id, organizationId },
        data: { adjusted: { increment: dto.days } },
      });
      const updated = await this.leaveBalanceService.recalculate(
        tx as Prisma.TransactionClient,
        row.id,
        organizationId,
      );
      return { before, after: updated.closing };
    });

    await this.auditLogService.logSelfApproval(actor, {
      module: 'LEAVE',
      targetId: employee.id,
      employeeId: dto.employeeId,
      request: 'Leave balance adjustment',
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LEAVE_BALANCE_ADJUSTED',
      module: 'LEAVE',
      organizationId,
      targetId: employee.id,
      details: {
        employee: `${employee.name} (${employee.employeeId})`,
        leaveType: leaveType.name,
        leaveTypeCode: leaveType.code,
        year,
        days: dto.days,
        before: result.before,
        after: result.after,
        reason: dto.reason.trim(),
      },
    });
    return {
      employeeId: employee.id,
      leaveTypeId: leaveType.id,
      year,
      days: dto.days,
      before: result.before,
      after: result.after,
    };
  }
}
