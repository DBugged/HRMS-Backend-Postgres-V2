// Purpose: Manages comp-off (compensatory time off) earning, review, expiry, and consumption.
// Responsibilities: Owns comp-off CRUD, balance calculation and expiry sweeping; exposes
// consumeForLeave()/releaseForLeave() for LeavesService to debit/credit balance transactionally when a
// COMPOFF-type Leave is approved or cancelled, rather than duplicating comp-off math there.
// Important: consumeForLeave() throws on insufficient balance rather than partially consuming — callers
// must check availability before approving. sweepExpired() runs inline before reads, not on a cron.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CompOff,
  CompOffStatus,
  NotificationCategory,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CreateCompOffDto } from './dto/create-comp-off.dto';
import { ReviewCompOffDto } from './dto/review-comp-off.dto';
import {
  consumeCompOff,
  releaseCompOff,
  sumAvailable,
} from './comp-off-consumption';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { ListCompOffsQueryDto } from './dto/list-comp-offs-query.dto';
import { paginate, skip } from '../common/pagination';
import {
  assertManagerDeptScope,
  deptScopedEmployeeIds,
} from '../common/dept-scope';

type Actor = Omit<User, 'password'>;

// Old system's LEAVE_APPROVE_ROLES — may raise/view comp-off on someone
// else's behalf.
const APPROVE_ROLES: Role[] = [Role.ADMIN, Role.HR, Role.MANAGER];

const CONSUMABLE_STATUSES: CompOffStatus[] = [
  CompOffStatus.APPROVED,
  CompOffStatus.PARTIALLY_AVAILED,
];

@Injectable()
export class CompOffService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly payrollSettingsService: PayrollSettingsService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  async earn(dto: CreateCompOffDto, actor: Actor, organizationId: string) {
    const targetEmployeeId =
      dto.employeeId && APPROVE_ROLES.includes(actor.role)
        ? dto.employeeId
        : actor.id;
    // A MANAGER may only earn comp-off on behalf of their own department's
    // employees — ADMIN/HR are unrestricted, EMPLOYEE never reaches this
    // branch since targetEmployeeId already collapses to actor.id above.
    if (dto.employeeId && actor.role === Role.MANAGER) {
      await assertManagerDeptScope(
        this.scopedPrisma,
        actor,
        organizationId,
        targetEmployeeId,
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    if (dto.earnedForDate > today) {
      throw new BadRequestException('earnedForDate cannot be in the future.');
    }

    const settings =
      await this.payrollSettingsService.getOrCreate(organizationId);
    const expiryDate = addDays(dto.earnedForDate, settings.compOffExpiryDays);

    return this.scopedPrisma.compOff.create({
      data: {
        organizationId,
        employeeId: targetEmployeeId,
        earnedForDate: dto.earnedForDate,
        reason: dto.reason ?? '',
        daysEarned: dto.daysEarned ?? 1,
        expiryDate,
      },
    });
  }

  async findAll(
    query: ListCompOffsQueryDto,
    actor: Actor,
    organizationId: string,
  ) {
    await this.sweepExpired(organizationId);

    const where: Prisma.CompOffWhereInput = { organizationId };
    if (actor.role === Role.EMPLOYEE) {
      where.employeeId = actor.id;
    } else if (actor.role === Role.MANAGER) {
      where.employeeId = {
        in: await deptScopedEmployeeIds(
          this.scopedPrisma,
          actor,
          organizationId,
        ),
      };
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }
    if (query.status) where.status = query.status;

    return paginate(
      () =>
        this.scopedPrisma.compOff.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.compOff.count({ where }),
      query.page,
      query.limit,
    );
  }

  async balance(
    employeeId: string | undefined,
    actor: Actor,
    organizationId: string,
  ) {
    const targetEmployeeId =
      employeeId && APPROVE_ROLES.includes(actor.role) ? employeeId : actor.id;
    // Same MANAGER-own-department restriction as earn() — a MANAGER must
    // not be able to read another department's employee's comp-off balance.
    if (employeeId && actor.role === Role.MANAGER) {
      await assertManagerDeptScope(
        this.scopedPrisma,
        actor,
        organizationId,
        targetEmployeeId,
      );
    }
    return {
      available: await this.available(targetEmployeeId, organizationId),
    };
  }

  // Read-only sum of unconsumed comp-off — used here and by LeavesService
  // for COMPOFF-type leave affordability checks.
  async available(employeeId: string, organizationId: string): Promise<number> {
    await this.sweepExpired(organizationId);
    const rows = await this.scopedPrisma.compOff.findMany({
      where: {
        organizationId,
        employeeId,
        status: { in: CONSUMABLE_STATUSES },
      },
    });
    return sumAvailable(rows);
  }

  async review(
    id: string,
    dto: ReviewCompOffDto,
    actor: Actor,
    organizationId: string,
  ) {
    const compOff = await this.findByIdOrThrow(id, organizationId);
    await assertManagerDeptScope(
      this.scopedPrisma,
      actor,
      organizationId,
      compOff.employeeId,
    );
    if (compOff.status !== CompOffStatus.PENDING) {
      throw new BadRequestException(
        'This comp-off request has already been reviewed.',
      );
    }

    await this.scopedPrisma.compOff.updateMany({
      where: { id, organizationId },
      data: {
        status: dto.decision,
        approvedById: actor.id,
        approvedAt: new Date(),
      },
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: compOff.employeeId, organizationId },
    });
    if (employee) {
      const title = `Comp-Off Request ${dto.decision}`;
      const message = `Your comp-off request for ${compOff.earnedForDate} has been ${dto.decision.toLowerCase()}.`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        // Reuses the LEAVE category, not a separate COMPOFF one — matches
        // the old system exactly.
        message,
        category: NotificationCategory.LEAVE,
      });
      await this.emailService.send({
        to: employee.email,
        subject: title,
        html: message,
      });
    }

    return this.findByIdOrThrow(id, organizationId);
  }

  // Called by LeavesService within its own transaction when a COMPOFF-type
  // Leave is approved. Throws if the balance is insufficient rather than
  // partially consuming — caller is expected to have already checked
  // availability before approving.
  async consumeForLeave(
    tx: Prisma.TransactionClient,
    employeeId: string,
    days: number,
    organizationId: string,
  ): Promise<void> {
    const rows = await tx.compOff.findMany({
      where: {
        organizationId,
        employeeId,
        status: { in: CONSUMABLE_STATUSES },
      },
    });
    const result = consumeCompOff(rows, days);
    if (result.shortfall > 0) {
      throw new ForbiddenException('Insufficient comp-off balance.');
    }
    for (const update of result.updated) {
      await tx.compOff.updateMany({
        where: { id: update.id, organizationId },
        data: { daysAvailed: update.daysAvailed, status: update.status },
      });
    }
  }

  // Called by LeavesService within its own transaction when a previously-
  // approved COMPOFF-type Leave is cancelled.
  async releaseForLeave(
    tx: Prisma.TransactionClient,
    employeeId: string,
    days: number,
    organizationId: string,
  ): Promise<void> {
    const rows = await tx.compOff.findMany({
      where: {
        organizationId,
        employeeId,
        status: { in: [...CONSUMABLE_STATUSES, CompOffStatus.AVAILED] },
      },
    });
    const updates = releaseCompOff(rows, days);
    for (const update of updates) {
      await tx.compOff.updateMany({
        where: { id: update.id, organizationId },
        data: { daysAvailed: update.daysAvailed, status: update.status },
      });
    }
  }

  private async sweepExpired(organizationId: string) {
    const today = new Date().toISOString().slice(0, 10);
    await this.scopedPrisma.compOff.updateMany({
      where: {
        organizationId,
        status: { in: CONSUMABLE_STATUSES },
        expiryDate: { lt: today },
      },
      data: { status: CompOffStatus.EXPIRED },
    });
  }

  private async findByIdOrThrow(
    id: string,
    organizationId: string,
  ): Promise<CompOff> {
    const compOff = await this.scopedPrisma.compOff.findFirst({
      where: { id, organizationId },
    });
    if (!compOff) throw new NotFoundException('Comp-off request not found.');
    return compOff;
  }
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
