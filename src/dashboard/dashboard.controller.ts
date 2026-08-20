// Purpose: Exposes role-specific dashboard aggregates (HR, executive, department-head, employee, payroll cost).
// Responsibilities: Validates the date-range query param and delegates all aggregation to DashboardService.
// Important: hr/executive are gated to ADMIN/HR (fixed here vs. old system); department-head/employee self-scope in the service.
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { DashboardService } from './dashboard.service';
import { DashboardRange } from './dashboard-date-math';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

const VALID_RANGES: DashboardRange[] = [
  'this_year',
  'previous_year',
  'this_quarter',
  'previous_quarter',
];

@ApiTags('dashboard')
@ApiBearerAuth('access-token')
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  // Old system left this endpoint unguarded (any authenticated user could
  // pull org-wide HR aggregates) — gated to [ADMIN, HR] here, a fix rather
  // than a port, matching the gate the old system's own Executive dashboard
  // already had.
  @Get('hr')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  hrDashboard(@CurrentUser() caller: Caller) {
    return this.dashboardService.hrDashboard(caller.organizationId);
  }

  @Get('hr/payroll-cost-summary')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  payrollCostSummary(
    @Query('range') range: string,
    @CurrentUser() caller: Caller,
  ) {
    const resolvedRange = VALID_RANGES.includes(range as DashboardRange)
      ? (range as DashboardRange)
      : 'this_year';
    return this.dashboardService.payrollCostSummary(
      resolvedRange,
      caller.organizationId,
    );
  }

  // No @Roles() — self-scoped to the caller's own department inline in the
  // service (see the service method's comment for the no-department
  // edge case, ported from the old system as-is).
  @Get('department-head')
  departmentHeadDashboard(@CurrentUser() caller: Caller) {
    return this.dashboardService.departmentHeadDashboard(
      caller,
      caller.organizationId,
    );
  }

  // No @Roles() — every authenticated user has their own employee
  // dashboard.
  @Get('employee')
  employeeDashboard(@CurrentUser() caller: Caller) {
    return this.dashboardService.employeeDashboard(
      caller,
      caller.organizationId,
    );
  }

  @Get('executive')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  executiveDashboard(@CurrentUser() caller: Caller) {
    return this.dashboardService.executiveDashboard(caller.organizationId);
  }
}
