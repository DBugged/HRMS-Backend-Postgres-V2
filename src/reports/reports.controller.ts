// Purpose: Exposes attendance/leave/payroll/employee/department/headcount/attrition reports as file exports.
// Responsibilities: Validates each query DTO and delegates report generation/export to ReportsService.
// Important: Base gate is ADMIN/HR/MANAGER, but payroll/employee/department/headcount/attrition routes further restrict to ADMIN/HR.
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role, User } from '@prisma/client';
import { ReportsService } from './reports.service';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';
import { sendReport } from './report-export';
import {
  AttendanceReportQueryDto,
  DepartmentLeaveSummaryReportQueryDto,
  EmployeeLeaveHistoryReportQueryDto,
  HeadcountReportQueryDto,
  LeaveBalanceReportQueryDto,
  LeaveReportQueryDto,
  PayrollReportQueryDto,
} from './dto/report-queries.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

// Old system's base router gate collapses to [ADMIN, HR, MANAGER]
// (hr_admin, department_head, ...PAYROLL_VIEW_ROLES); the payroll/employee/
// department/headcount/attrition reports were further restricted to
// [ADMIN, HR] only in the old router (hr_admin, administrator) — each
// route below carries its own @Roles() matching that split exactly.
@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('reports')
@Roles(Role.ADMIN, Role.HR, Role.MANAGER)
@UseGuards(RolesGuard)
// Every route here renders an Excel/CSV/PDF export, some over an org's
// full history — a much tighter cap than the 100/min global default.
@Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('attendance')
  async attendance(
    @Query() query: AttendanceReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.reportsService.attendanceReport(
      query,
      caller,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('leave')
  async leave(
    @Query() query: LeaveReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.reportsService.leaveReport(
      query,
      caller,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('leave/balance')
  async leaveBalance(
    @Query() query: LeaveBalanceReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.reportsService.leaveBalanceReport(
      query,
      caller,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('leave/employee-history')
  async employeeLeaveHistory(
    @Query() query: EmployeeLeaveHistoryReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.reportsService.employeeLeaveHistoryReport(
      query,
      caller,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('leave/department-summary')
  async departmentLeaveSummary(
    @Query() query: DepartmentLeaveSummaryReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.reportsService.departmentLeaveSummaryReport(
      query,
      caller,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('payroll')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async payroll(
    @Query() query: PayrollReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.reportsService.payrollReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('employees')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async employees(
    @Query('format') format: 'xlsx' | 'csv' | 'pdf' = 'xlsx',
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.reportsService.employeeReport(
      caller.organizationId,
    );
    await sendReport(res, { ...report, format });
  }

  @Get('departments')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async departments(
    @Query('format') format: 'xlsx' | 'csv' | 'pdf' = 'xlsx',
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.reportsService.departmentReport(
      caller.organizationId,
    );
    await sendReport(res, { ...report, format });
  }

  @Get('headcount-trend')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async headcountTrend(
    @Query() query: HeadcountReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.reportsService.headcountTrendReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }

  @Get('attrition')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async attrition(
    @Query() query: HeadcountReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.reportsService.attritionReport(
      query,
      caller.organizationId,
    );
    await sendReport(res, { ...report, format: query.format ?? 'xlsx' });
  }
}
