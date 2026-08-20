// Purpose: Exposes fixed payroll reports (salary register, bank transfer, income tax, PF, ESI, PT, CTC, Form16, audit) as file exports.
// Responsibilities: Validates each query DTO and delegates report generation/export to PayrollReportsService.
// Important: Entire controller is gated to ADMIN/HR and throttled as an expensive operation.
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role, User } from '@prisma/client';
import { PayrollReportsService } from './payroll-reports.service';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';
import { sendReport } from './report-export';
import {
  PayrollAuditReportQueryDto,
  PayrollReportQueryDto,
} from './dto/report-queries.dto';
import { Form16ReportQueryDto } from './dto/form16-report-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

// Old system's PAYROLL_VIEW_ROLES collapses to [ADMIN, HR], same
// convention used throughout Payroll/Reimbursements/Loans/Settlements.
@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('reports/payroll')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
@Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
export class PayrollReportsController {
  constructor(private readonly payrollReportsService: PayrollReportsService) {}

  @Get('salary-register')
  async salaryRegister(
    @Query() query: PayrollReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.payrollReportsService.salaryRegisterReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('bank-transfer')
  async bankTransfer(
    @Query() query: PayrollReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.payrollReportsService.bankTransferReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('income-tax')
  async incomeTax(
    @Query() query: PayrollReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.payrollReportsService.incomeTaxReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('pf')
  async pf(
    @Query() query: PayrollReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.payrollReportsService.pfReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('esi')
  async esi(
    @Query() query: PayrollReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.payrollReportsService.esiReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('pt')
  async pt(
    @Query() query: PayrollReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.payrollReportsService.ptReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('employer-contributions')
  async employerContributions(
    @Query() query: PayrollReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.payrollReportsService.employerContributionsReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('bonus')
  async bonus(
    @Query() query: PayrollReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.payrollReportsService.bonusReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('ctc')
  async ctc(
    @Query() query: PayrollReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.payrollReportsService.ctcReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('form16')
  async form16(
    @Query() query: Form16ReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.payrollReportsService.form16Report(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('audit')
  async audit(
    @Query() query: PayrollAuditReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.payrollReportsService.payrollAuditReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }
}
