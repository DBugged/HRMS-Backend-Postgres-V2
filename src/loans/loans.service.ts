import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LoanStatus, Prisma, Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { calculateEmi } from './loan-math';
import { CreateLoanDto } from './dto/create-loan.dto';
import { UpdateLoanStatusDto } from './dto/update-loan-status.dto';
import { RecordRepaymentDto } from './dto/record-repayment.dto';
import { QueryLoanDto } from './dto/query-loan.dto';

type Actor = Omit<User, 'password'>;

@Injectable()
export class LoansService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  async findAll(query: QueryLoanDto, actor: Actor, organizationId: string) {
    const where: Prisma.LoanWhereInput = { organizationId };

    if (actor.role === Role.EMPLOYEE) {
      where.employeeId = actor.id;
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }
    if (query.status) where.status = query.status;

    return this.scopedPrisma.loan.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(dto: CreateLoanDto, actor: Actor, organizationId: string) {
    const emiAmount = calculateEmi(
      dto.principal,
      dto.interestRate ?? 0,
      dto.tenureMonths,
    );

    return this.scopedPrisma.loan.create({
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
    return this.scopedPrisma.loan.findFirstOrThrow({
      where: { id, organizationId },
    });
  }

  // Called by the payroll engine when a loan EMI is deducted for a given
  // run (payroll-loan integration not built yet — see the payrollRunId
  // deferral comment on LoanRepayment) — exposed here too so HR can
  // manually record/adjust a repayment.
  async recordRepayment(
    id: string,
    dto: RecordRepaymentDto,
    organizationId: string,
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

    return this.scopedPrisma.$transaction(async (tx) => {
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
  }

  async getRepayments(id: string, actor: Actor, organizationId: string) {
    const loan = await this.scopedPrisma.loan.findFirst({
      where: { id, organizationId },
    });
    if (!loan) throw new NotFoundException('Loan not found.');
    // findAll scopes an EMPLOYEE to their own loans via the `where` filter —
    // this endpoint is reached by loan id rather than through that
    // pre-filtered list, so it has to apply the same ownership check
    // directly.
    if (actor.role === Role.EMPLOYEE && loan.employeeId !== actor.id) {
      throw new ForbiddenException('Not authorized to view this loan.');
    }

    return this.scopedPrisma.loanRepayment.findMany({
      where: { loanId: id, organizationId },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
    });
  }
}
