// Purpose: Manages employee loans (advances) — sanctioning (direct or via employee request/HR
// approve-reject), status transitions, and repayment recording.
// Responsibilities: Owns EMI calculation at creation/approval (calculateEmi) and outstanding-balance
// bookkeeping on each repayment; recordRepayment() is called by the payroll engine when an EMI is deducted,
// but is also exposed for HR to record/adjust a repayment manually.
// Important: getRepayments() re-applies the EMPLOYEE-can-only-see-own-loan and MANAGER-own-dept-only checks
// independently of findAll's filter, since it's reached directly by loan id rather than through the pre-filtered list.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LoanStatus,
  LoanType,
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
import { RequestLoanDto } from './dto/request-loan.dto';
import { ApproveLoanDto } from './dto/approve-loan.dto';
import { RejectLoanDto } from './dto/reject-loan.dto';
import { UpdateLoanStatusDto } from './dto/update-loan-status.dto';
import { RecordRepaymentDto } from './dto/record-repayment.dto';
import { QueryLoanDto } from './dto/query-loan.dto';
import { paginate, skip } from '../common/pagination';
import {
  deptScopedEmployeeIds,
  assertNotSelfApproval,
} from '../common/dept-scope';
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

  // A salary Advance is an early draw against the employee's own upcoming
  // pay — the money is already theirs, so unlike a Loan it's never
  // interest-bearing. Enforced wherever a rate gets set (direct create and
  // approve()) rather than just defaulted, so HR can't accidentally sneak
  // interest onto an advance by typing a non-zero rate.
  private assertAdvanceIsInterestFree(
    loanType: LoanType,
    interestRate: number,
  ): void {
    if (loanType === LoanType.ADVANCE && interestRate > 0) {
      throw new BadRequestException(
        'A salary advance is interest-free — set 0%, or use Loan instead if interest applies.',
      );
    }
  }

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
            // closureReason/closedAt are plain scalars on Loan and flow
            // through automatically, but closedBy is a relation — needs an
            // explicit include or the History modal's "Closed by" always
            // reads as blank even when closedById is actually set.
            closedBy: { select: { id: true, name: true } },
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
    this.assertAdvanceIsInterestFree(
      dto.loanType ?? LoanType.LOAN,
      dto.interestRate ?? 0,
    );
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
        {
          employeeName: employee.name,
          loanType: loan.loanType,
          principal: String(dto.principal),
          emiAmount: String(emiAmount),
          tenureMonths: String(dto.tenureMonths),
        },
        { subject: title, html: message },
      );
      await this.emailService.send({
        to: employee.email,
        subject: rendered.subject,
        html: rendered.html,
      });
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

  // Self-service counterpart to create() — an employee requesting a loan
  // for themselves rather than HR sanctioning one directly. Sits PENDING
  // until approve()/reject(); interestRate/startMonth/startYear aren't the
  // employee's call, so they're placeholders here (0%, current month/year)
  // that approve() always overwrites with HR's real terms before the loan
  // ever goes ACTIVE — emiAmount below is purely an indicative estimate
  // for the request, not what the employee will actually be held to.
  async request(dto: RequestLoanDto, actor: Actor, organizationId: string) {
    const now = new Date();
    const emiAmount = calculateEmi(dto.principal, 0, dto.tenureMonths);

    const loan = await this.scopedPrisma.loan.create({
      data: {
        organizationId,
        employeeId: actor.id,
        loanType: dto.loanType,
        principal: dto.principal,
        interestRate: 0,
        tenureMonths: dto.tenureMonths,
        emiAmount,
        startMonth: now.getMonth() + 1,
        startYear: now.getFullYear(),
        outstandingBalance: dto.principal,
        reason: dto.reason ?? '',
        status: LoanStatus.PENDING,
      },
    });

    const hrUsers = await this.scopedPrisma.user.findMany({
      where: { organizationId, role: { in: [Role.HR, Role.ADMIN] } },
      select: { id: true },
    });
    await this.notificationsService.createMany(
      hrUsers.map((u) => ({
        organizationId,
        userId: u.id,
        title: 'Loan/Advance Request Pending Review',
        message: `${actor.name} requested a ${loan.loanType.toLowerCase()} of ${dto.principal} over ${dto.tenureMonths} month(s).`,
        category: NotificationCategory.GENERAL,
      })),
    );

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LOAN_REQUESTED',
      module: 'PAYROLL',
      organizationId,
      targetId: loan.id,
      details: { principal: dto.principal, tenureMonths: dto.tenureMonths },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: actor.id,
      eventKey: 'LOAN_REQUESTED',
      performedById: actor.id,
      description: `${loan.loanType} of ${dto.principal} requested.`,
    });

    return loan;
  }

  async approve(
    id: string,
    dto: ApproveLoanDto,
    actor: Actor,
    organizationId: string,
  ) {
    const loan = await this.scopedPrisma.loan.findFirst({
      where: { id, organizationId },
    });
    if (!loan) throw new NotFoundException('Loan not found.');
    if (loan.status !== LoanStatus.PENDING) {
      throw new BadRequestException('Only a pending request can be approved.');
    }
    // An HR/Admin can't approve their own loan request — same self-review
    // gate as document/probation reviews elsewhere; ADMIN is exempt since
    // there's no one above an Admin to approve it instead.
    assertNotSelfApproval(actor, loan.employeeId);

    const interestRate = dto.interestRate ?? 0;
    this.assertAdvanceIsInterestFree(loan.loanType, interestRate);
    const tenureMonths = dto.tenureMonths ?? loan.tenureMonths;
    const emiAmount = calculateEmi(loan.principal, interestRate, tenureMonths);

    await this.scopedPrisma.loan.updateMany({
      where: { id, organizationId },
      data: {
        status: LoanStatus.ACTIVE,
        interestRate,
        tenureMonths,
        emiAmount,
        startMonth: dto.startMonth,
        startYear: dto.startYear,
        outstandingBalance: loan.principal,
        approvedById: actor.id,
      },
    });
    const updated = await this.scopedPrisma.loan.findFirstOrThrow({
      where: { id, organizationId },
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: loan.employeeId, organizationId },
    });
    if (employee) {
      const title = 'Loan Request Approved';
      const message = `Your ${loan.loanType} request of ${loan.principal} has been approved, repayable as ${emiAmount}/month over ${tenureMonths} month(s) starting ${dto.startMonth}/${dto.startYear}.`;
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
        {
          employeeName: employee.name,
          loanType: loan.loanType,
          principal: String(loan.principal),
          emiAmount: String(emiAmount),
          tenureMonths: String(tenureMonths),
        },
        { subject: title, html: message },
      );
      await this.emailService.send({
        to: employee.email,
        subject: rendered.subject,
        html: rendered.html,
      });
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LOAN_APPROVED',
      module: 'PAYROLL',
      organizationId,
      targetId: id,
      details: { employeeId: loan.employeeId, principal: loan.principal },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: loan.employeeId,
      eventKey: 'LOAN_APPROVED',
      performedById: actor.id,
      description: `${loan.loanType} of ${loan.principal} approved.`,
    });

    return updated;
  }

  async reject(
    id: string,
    dto: RejectLoanDto,
    actor: Actor,
    organizationId: string,
  ) {
    const loan = await this.scopedPrisma.loan.findFirst({
      where: { id, organizationId },
    });
    if (!loan) throw new NotFoundException('Loan not found.');
    if (loan.status !== LoanStatus.PENDING) {
      throw new BadRequestException('Only a pending request can be rejected.');
    }
    assertNotSelfApproval(actor, loan.employeeId);

    await this.scopedPrisma.loan.updateMany({
      where: { id, organizationId },
      data: { status: LoanStatus.REJECTED, approvedById: actor.id },
    });
    const updated = await this.scopedPrisma.loan.findFirstOrThrow({
      where: { id, organizationId },
    });

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: loan.employeeId, organizationId },
    });
    if (employee) {
      const title = 'Loan Request Rejected';
      const message = dto.reason
        ? `Your ${loan.loanType} request of ${loan.principal} was rejected: ${dto.reason}`
        : `Your ${loan.loanType} request of ${loan.principal} was rejected.`;
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
        {
          employeeName: employee.name,
          loanType: loan.loanType,
          status: LoanStatus.REJECTED,
        },
        { subject: title, html: message },
      );
      await this.emailService.send({
        to: employee.email,
        subject: rendered.subject,
        html: rendered.html,
      });
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LOAN_REJECTED',
      module: 'PAYROLL',
      organizationId,
      targetId: id,
      details: { employeeId: loan.employeeId, reason: dto.reason ?? '' },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId: loan.employeeId,
      eventKey: 'LOAN_REJECTED',
      performedById: actor.id,
      description: `${loan.loanType} request rejected.`,
    });

    return updated;
  }

  async updateStatus(
    id: string,
    dto: UpdateLoanStatusDto,
    organizationId: string,
    actorId: string,
  ) {
    const loan = await this.scopedPrisma.loan.findFirst({
      where: { id, organizationId },
    });
    if (!loan) throw new NotFoundException('Loan not found.');
    // A pending request has no terms set yet (interestRate/EMI/start
    // date) — it must go through approve()/reject(), not this generic
    // status flip, so those terms always get filled in together.
    if (loan.status === LoanStatus.PENDING) {
      throw new BadRequestException(
        'Use the approve or reject action for a pending request.',
      );
    }

    if (
      dto.status === LoanStatus.CLOSED &&
      loan.outstandingBalance > 0 &&
      !dto.reason
    ) {
      throw new BadRequestException(
        'This loan still has an outstanding balance — a reason is required to close it anyway.',
      );
    }
    if (dto.status === LoanStatus.CANCELLED && !dto.reason) {
      throw new BadRequestException('A reason is required to cancel a loan.');
    }

    const isClosureStatus =
      dto.status === LoanStatus.CLOSED || dto.status === LoanStatus.CANCELLED;

    await this.scopedPrisma.loan.updateMany({
      where: { id, organizationId },
      data: {
        status: dto.status,
        ...(isClosureStatus
          ? {
              closureReason: dto.reason ?? '',
              closedAt: new Date(),
              closedById: actorId,
            }
          : {}),
      },
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
            ? loan.outstandingBalance === 0
              ? `Your ${loan.loanType} loan has been fully repaid and is now closed.`
              : `Your ${loan.loanType} loan has been closed with an outstanding balance of ₹${loan.outstandingBalance}. Reason: ${dto.reason}.`
            : dto.status === LoanStatus.CANCELLED
              ? `Your ${loan.loanType} loan has been cancelled. Reason: ${dto.reason}.`
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
          {
            employeeName: employee.name,
            loanType: loan.loanType,
            status: dto.status,
            reason: dto.reason ?? '',
            outstandingBalance: String(loan.outstandingBalance),
          },
          { subject: title, html: message },
        );
        await this.emailService.send({
          to: employee.email,
          subject: rendered.subject,
          html: rendered.html,
        });
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
