// Purpose: Manages employee loans (advances) — sanctioning, status transitions, and repayment recording.
// Responsibilities: Owns EMI calculation at creation (calculateEmi) and outstanding-balance bookkeeping on
// each repayment; recordRepayment() is called by the payroll engine when an EMI is deducted, but is also
// exposed for HR to record/adjust a repayment manually.
// Important: getRepayments() re-applies the EMPLOYEE-can-only-see-own-loan and MANAGER-own-dept-only checks
// independently of findAll's filter, since it's reached directly by loan id rather than through the pre-filtered list.
import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LoanStatus,
  NotificationCategory,
  Prisma,
  Role,
  User,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { calculateEmi } from './loan-math';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/email.service';
import { CreateLoanDto } from './dto/create-loan.dto';
import { UpdateLoanStatusDto } from './dto/update-loan-status.dto';
import { RecordRepaymentDto } from './dto/record-repayment.dto';
import { QueryLoanDto } from './dto/query-loan.dto';
import { paginate, skip } from '../common/pagination';
import { deptScopedEmployeeIds } from '../common/dept-scope';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';

type Actor = Omit<User, 'password'>;

@Injectable()
export class LoansService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
    private readonly auditLogService: AuditLogService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly emailTemplatesService: EmailTemplatesService,
  ) {}

  async findAll(query: QueryLoanDto, actor: Actor, organizationId: string) {
    const where: Prisma.LoanWhereInput = { organizationId };

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
        this.scopedPrisma.loan.findMany({
          where,
          include: {
            employee: { select: { id: true, name: true, employeeId: true } },
          },
          orderBy: { createdAt: 'desc' },
          skip: skip(query.page, query.limit),
          take: query.limit,
        }),
      () => this.scopedPrisma.loan.count({ where }),
      query.page,
      query.limit,
    );
  }

  async create(dto: CreateLoanDto, actor: Actor, organizationId: string) {
    const emiAmount = calculateEmi(
      dto.principal,
      dto.interestRate ?? 0,
      dto.tenureMonths,
    );

    const loan = await this.scopedPrisma.loan.create({
      data: {
        organizationId,
        employeeId: dto.employeeId,
        loanType: dto.loanType,
        principal: dto.principal,
        interestRate: dto.interestRate ?? 0,
        tenureMonths: dto.tenureMonths,
        emiAmount,
        startMonth: dto.startMonth,
        startYear: dto.startYear,
        outstandingBalance: dto.principal,
        reason: dto.reason ?? '',
        approvedById: actor.id,
      },
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: dto.employeeId, organizationId },
    });
    if (employee) {
      const title = 'Loan Sanctioned';
      const message = `A ${loan.loanType} loan of ${dto.principal} has been sanctioned for you, repayable as ${emiAmount}/month over ${dto.tenureMonths} month(s) starting ${dto.startMonth}/${dto.startYear}.`;
      await this.notificationsService.create({
        organizationId,
        userId: employee.id,
        title,
        message,
        category: NotificationCategory.GENERAL,
      });
      const rendered = await this.emailTemplatesService.renderOccasion(
        organizationId,
        'LOAN_SANCTIONED',
        { employeeName: employee.name, loanType: loan.loanType, principal: String(dto.principal), emiAmount: String(emiAmount), tenureMonths: String(dto.tenureMonths) },
        { subject: title, html: message },
      );
      await this.emailService.send({ to: employee.email, subject: rendered.subject, html: rendered.html });
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LOAN_ISSUED',
      module: 'PAYROLL',
      organizationId,
      targetId: loan.id,
      details: {
        employeeId: dto.employeeId,
        principal: dto.principal,
        tenureMonths: dto.tenureMonths,
      },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: dto.employeeId,
      eventKey: 'LOAN_ISSUED',
      performedById: actor.id,
      description: `${loan.loanType} loan of ${dto.principal} sanctioned.`,
    });

    return loan;
  }

  async updateStatus(
    id: string,
    dto: UpdateLoanStatusDto,
    organizationId: string,
  ) {
    const loan = await this.scopedPrisma.loan.findFirst({
      where: { id, organizationId },
    });
    if (!loan) throw new NotFoundException('Loan not found.');

    await this.scopedPrisma.loan.updateMany({
      where: { id, organizationId },
      data: { status: dto.status },
    });
    const updated = await this.scopedPrisma.loan.findFirstOrThrow({
      where: { id, organizationId },
    });

    if (dto.status !== loan.status) {
      const employee = await this.scopedPrisma.user.findFirst({
        where: { id: loan.employeeId, organizationId },
      });
      if (employee) {
        const title = `Loan ${dto.status === LoanStatus.CLOSED ? 'Closed' : dto.status === LoanStatus.CANCELLED ? 'Cancelled' : 'Updated'}`;
        const message =
          dto.status === LoanStatus.CLOSED
            ? `Your ${loan.loanType} loan has been fully repaid and is now closed.`
            : dto.status === LoanStatus.CANCELLED
              ? `Your ${loan.loanType} loan has been cancelled.`
              : `Your ${loan.loanType} loan status is now ${dto.status}.`;
        await this.notificationsService.create({
          organizationId,
          userId: employee.id,
          title,
          message,
          category: NotificationCategory.GENERAL,
        });
        const rendered = await this.emailTemplatesService.renderOccasion(
          organizationId,
          'LOAN_STATUS_UPDATE',
          { employeeName: employee.name, loanType: loan.loanType, status: dto.status },
          { subject: title, html: message },
        );
        await this.emailService.send({ to: employee.email, subject: rendered.subject, html: rendered.html });
      }
    }

    return updated;
  }

  // Called by the payroll engine when a loan EMI is deducted for a given
  // run (payroll-loan integration not built yet — see the payrollRunId
  // deferral comment on LoanRepayment) — exposed here too so HR can
  // manually record/adjust a repayment.
  async recordRepayment(
    id: string,
    dto: RecordRepaymentDto,
    organizationId: string,
    actorId?: string,
  ) {
    const loan = await this.scopedPrisma.loan.findFirst({
      where: { id, organizationId },
    });
    if (!loan) throw new NotFoundException('Loan not found.');

    const principalComponent = Math.min(dto.amount, loan.outstandingBalance);
    const outstandingBalance = Math.max(
      0,
      loan.outstandingBalance - principalComponent,
    );
    const status = outstandingBalance === 0 ? LoanStatus.CLOSED : loan.status;

    const result = await this.scopedPrisma.$transaction(async (tx) => {
      await tx.loan.updateMany({
        where: { id, organizationId },
        data: { outstandingBalance, status },
      });
      const repayment = await tx.loanRepayment.create({
        data: {
          organizationId,
          loanId: id,
          payrollRunId: dto.payrollRun ?? null,
          month: dto.month,
          year: dto.year,
          amount: dto.amount,
          principalComponent,
          interestComponent: Math.max(0, dto.amount - principalComponent),
          balanceAfter: outstandingBalance,
        },
      });
      const updatedLoan = await tx.loan.findFirstOrThrow({
        where: { id, organizationId },
      });
      return { repayment, loan: updatedLoan };
    });

    await this.auditLogService.log({
      actorId: actorId ?? loan.approvedById ?? loan.employeeId,
      action: 'LOAN_REPAYMENT_RECORDED',
      module: 'PAYROLL',
      organizationId,
      targetId: id,
      details: {
        employeeId: loan.employeeId,
        amount: dto.amount,
        outstandingBalance,
      },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: loan.employeeId,
      eventKey: 'LOAN_REPAYMENT_RECORDED',
      performedById: actorId ?? loan.approvedById,
      description: `Loan repayment of ${dto.amount} recorded.`,
    });

    return result;
  }

  async getRepayments(id: string, actor: Actor, organizationId: string) {
    const loan = await this.scopedPrisma.loan.findFirst({
      where: { id, organizationId },
      include: { employee: true },
    });
    if (!loan) throw new NotFoundException('Loan not found.');
    // findAll scopes an EMPLOYEE to their own loans, and a MANAGER to their
    // own department's, via the `where` filter — this endpoint is reached
    // by loan id rather than through that pre-filtered list, so it has to
    // apply the same ownership/dept checks directly.
    if (actor.role === Role.EMPLOYEE && loan.employeeId !== actor.id) {
      throw new ForbiddenException('Not authorized to view this loan.');
    }
    if (
      actor.role === Role.MANAGER &&
      loan.employee.departmentId !== actor.departmentId
    ) {
      throw new ForbiddenException('Not authorized to view this loan.');
    }

    return this.scopedPrisma.loanRepayment.findMany({
      where: { loanId: id, organizationId },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
  }
}
