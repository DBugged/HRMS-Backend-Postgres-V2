import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LeaveEncashmentStatus,
  NotificationCategory,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { LeaveBalanceService } from '../leave-balances/leave-balance.service';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { EmployeeSalaryComponentsService } from '../employee-salary-components/employee-salary-components.service';
import { getFinancialYear } from '../payroll-settings/financial-year';
import { localDateStr } from '../employee-salary-components/salary-structure-math';
import { RequestLeaveEncashmentDto } from './dto/request-leave-encashment.dto';
import { ReviewLeaveEncashmentDto } from './dto/review-leave-encashment.dto';
import { QueryLeaveEncashmentDto } from './dto/query-leave-encashment.dto';
import { paginate } from '../common/pagination';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';

type Actor = Omit<User, 'password'>;

interface EncashmentRule {
  allowed?: boolean;
  maxDaysPerYear?: number;
  minBalanceToRetain?: number;
}

@Injectable()
export class LeaveEncashmentsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly leaveBalanceService: LeaveBalanceService,
    private readonly payrollSettingsService: PayrollSettingsService,
    private readonly employeeSalaryComponentsService: EmployeeSalaryComponentsService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  async findAll(
    query: QueryLeaveEncashmentDto,
    actor: Actor,
    organizationId: string,
  ) {
    const where: Prisma.LeaveEncashmentWhereInput = { organizationId };

    if (actor.role === Role.EMPLOYEE) {
      where.employeeId = actor.id;
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }
    if (query.status) where.status = query.status;

    return paginate(
      () =>
        this.scopedPrisma.leaveEncashment.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
            leaveType: { select: { id: true, name: true, code: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
      () => this.scopedPrisma.leaveEncashment.count({ where }),
      query.page,
      query.limit,
    );
  }

  async request(
    dto: RequestLeaveEncashmentDto,
    actor: Actor,
    organizationId: string,
  ) {
    const leaveType = await this.scopedPrisma.leaveType.findFirst({
      where: { id: dto.leaveType, organizationId },
    });
    if (!leaveType) throw new NotFoundException('Leave type not found.');

    const rule = (leaveType.encashment ?? {}) as EncashmentRule;
    if (!rule.allowed) {
      throw new BadRequestException(
        `${leaveType.name} does not allow encashment.`,
      );
    }
    if (rule.maxDaysPerYear && dto.days > rule.maxDaysPerYear) {
      throw new BadRequestException(
        `Cannot encash more than ${rule.maxDaysPerYear} day(s) per year for this leave type.`,
      );
    }

    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;

    return this.scopedPrisma.$transaction(async (tx) => {
      const balanceRow = await this.leaveBalanceService.ensureBalanceRow(
        tx,
        actor.id,
        leaveType.id,
        year,
        organizationId,
      );
      const available = balanceRow.closing;
      const minRetain = rule.minBalanceToRetain ?? 0;
      if (!dto.days || dto.days > available - minRetain) {
        throw new BadRequestException(
          `Cannot encash more than ${Math.max(0, available - minRetain)} day(s) (must retain ${minRetain}).`,
        );
      }

      const currentBasic =
        await this.employeeSalaryComponentsService.getCurrentMonthlyValue(
          actor.id,
          'BASIC',
          localDateStr(now),
          organizationId,
        );
      const ratePerDay = currentBasic / 30;
      const settings =
        await this.payrollSettingsService.getOrCreate(organizationId);
      const financialYear = getFinancialYear(
        month,
        year,
        settings.financialYearStartMonth,
      );

      return tx.leaveEncashment.create({
        data: {
          organizationId,
          employeeId: actor.id,
          leaveTypeId: leaveType.id,
          days: dto.days,
          ratePerDay,
          amount: Math.round(ratePerDay * dto.days),
          financialYear,
        },
      });
    });
  }

  // Single-level review, matching Overtime — no "already reviewed" guard,
  // ported as-is (the old controller allows re-targeting APPROVED<->PROCESSED
  // freely).
  async review(
    id: string,
    dto: ReviewLeaveEncashmentDto,
    actor: Actor,
    organizationId: string,
  ) {
    const row = await this.scopedPrisma.leaveEncashment.findFirst({
      where: { id, organizationId },
    });
    if (!row)
      throw new NotFoundException('Leave encashment request not found.');

    const result = await this.scopedPrisma.$transaction(async (tx) => {
      await tx.leaveEncashment.updateMany({
        where: { id, organizationId },
        data: { status: dto.status, approvedById: actor.id },
      });

      // A second, independent deduction from the balance — the request
      // step only validated availability, it never reserved a hold. Ported
      // as-is, including the old system's latent race condition.
      if (dto.status === LeaveEncashmentStatus.APPROVED && row.leaveTypeId) {
        const year = new Date().getFullYear();
        const balanceRow = await this.leaveBalanceService.ensureBalanceRow(
          tx,
          row.employeeId,
          row.leaveTypeId,
          year,
          organizationId,
        );
        await tx.leaveBalance.updateMany({
          where: { id: balanceRow.id, organizationId },
          data: { encashed: balanceRow.encashed + row.days },
        });
        await this.leaveBalanceService.recalculate(
          tx,
          balanceRow.id,
          organizationId,
        );
      }

      return tx.leaveEncashment.findFirstOrThrow({
        where: { id, organizationId },
      });
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: row.employeeId, organizationId },
    });
    if (employee) {
      const title = `Leave Encashment Request ${dto.status}`;
      const message = `Your leave encashment request for ${row.days} day(s) (${row.amount}) has been ${dto.status.toLowerCase()}.`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.LEAVE,
      });
      await this.emailService.send({
        to: employee.email,
        subject: title,
        html: message,
      });
    }

    return result;
  }
}
