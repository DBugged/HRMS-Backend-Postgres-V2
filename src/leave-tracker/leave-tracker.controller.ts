// Purpose: Exposes the Leave Tracker's month-grid and balance-strip endpoints.
// Responsibilities: Validates DTOs and delegates all logic to LeaveTrackerService.
// Important: Entire controller is gated to ADMIN/HR/MANAGER; MANAGER's forced own-department scoping is
// enforced in the service, not here.
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { LeaveTrackerService } from './leave-tracker.service';
import { QueryLeaveTrackerGridDto } from './dto/query-leave-tracker-grid.dto';
import { QueryLeaveTrackerBalancesDto } from './dto/query-leave-tracker-balances.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('leave-tracker')
@ApiBearerAuth('access-token')
@Roles(Role.ADMIN, Role.HR, Role.MANAGER)
@UseGuards(RolesGuard)
@Controller('leave-tracker')
export class LeaveTrackerController {
  constructor(private readonly leaveTrackerService: LeaveTrackerService) {}

  @Get('grid')
  grid(
    @Query() query: QueryLeaveTrackerGridDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leaveTrackerService.grid(query, caller, caller.organizationId);
  }

  @Get('balances')
  balances(
    @Query() query: QueryLeaveTrackerBalancesDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leaveTrackerService.balances(
      query,
      caller,
      caller.organizationId,
    );
  }
}
