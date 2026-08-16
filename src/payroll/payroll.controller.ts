import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PayrollRunStatus, Role, User } from '@prisma/client';
import { PayrollService } from './payroll.service';
import { PayslipPdfService } from './payslip-pdf.service';
import { DraftPayrollDto } from './dto/draft-payroll.dto';
import { CalculatePayrollDto } from './dto/calculate-payroll.dto';
import { QueryPayrollDto } from './dto/query-payroll.dto';
import { AdjustPayrollDto } from './dto/adjust-payroll.dto';
import { BulkTransitionPayrollDto } from './dto/bulk-transition-payroll.dto';
import { UnlockPayrollDto } from './dto/unlock-payroll.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';

type Caller = Omit<User, 'password'>;

const FINALIZED_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.LOCKED,
  PayrollRunStatus.PAID,
];

@ApiTags('payroll')
@ApiBearerAuth('access-token')
@Controller('payroll')
export class PayrollController {
  constructor(
    private readonly payrollService: PayrollService,
    private readonly payslipPdfService: PayslipPdfService,
  ) {}

  // No @Roles() — any authenticated caller, self/dept-scoped inline in
  // the service (EMPLOYEE forced to own, MANAGER to own department).
  @Get()
  findAll(@Query() query: QueryPayrollDto, @CurrentUser() caller: Caller) {
    return this.payrollService.findAll(query, caller, caller.organizationId);
  }

  // Registered before ':id' so Nest doesn't try to match "history" as a
  // route param — same reason as Holidays' bulk-import and LeaveTypes'
  // eligible/me routes.
  @Get('history')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  history(@Query() query: QueryPayrollDto, @CurrentUser() caller: Caller) {
    return this.payrollService.getHistory(query, caller, caller.organizationId);
  }

  // No @Roles() — 403 for an EMPLOYEE viewing someone else's payslip is
  // enforced inline in the service; MANAGER/ADMIN/HR may view any single
  // payslip by id (only the list endpoint above scopes MANAGER by dept).
  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.findOne(id, caller, caller.organizationId);
  }

  // Self-scoped for EMPLOYEE (findOne already 403s otherwise); blocked
  // unless the run has passed approval, matching the old system's
  // downloadPayslipPdf exactly.
  @Get(':id/pdf')
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async downloadPdf(
    @Param('id') id: string,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const run = await this.payrollService.findOne(
      id,
      caller,
      caller.organizationId,
    );
    if (!FINALIZED_STATUSES.includes(run.status)) {
      throw new BadRequestException('This payslip is not finalized yet.');
    }
    const { buffer, filename } =
      await this.payslipPdfService.buildPayslipPdfBuffer(
        id,
        caller.organizationId,
      );
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=${filename}`,
    });
    res.send(buffer);
  }

  @Post('draft')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  draft(@Body() dto: DraftPayrollDto, @CurrentUser() caller: Caller) {
    return this.payrollService.draft(dto, caller, caller.organizationId);
  }

  @Post('calculate')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  calculate(@Body() dto: CalculatePayrollDto, @CurrentUser() caller: Caller) {
    return this.payrollService.calculate(dto, caller, caller.organizationId);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  adjust(
    @Param('id') id: string,
    @Body() dto: AdjustPayrollDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.adjust(id, dto, caller, caller.organizationId);
  }

  @Post('bulk-transition')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  bulkTransition(
    @Body() dto: BulkTransitionPayrollDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.bulkTransition(
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Post(':id/verify')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  verify(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.verify(id, caller, caller.organizationId);
  }

  @Post(':id/approve')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  approve(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.approve(id, caller, caller.organizationId);
  }

  @Post(':id/lock')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  lock(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.lock(id, caller, caller.organizationId);
  }

  @Post(':id/pay')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  pay(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.payrollService.pay(id, caller, caller.organizationId);
  }

  // Old system's PAYROLL_UNLOCK_ROLES (hr_admin, payroll_manager,
  // administrator) collapses to the same [ADMIN, HR] set as every other
  // payroll-workflow action here.
  @Post(':id/unlock')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  unlock(
    @Param('id') id: string,
    @Body() dto: UnlockPayrollDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.payrollService.unlock(id, dto, caller, caller.organizationId);
  }
}
