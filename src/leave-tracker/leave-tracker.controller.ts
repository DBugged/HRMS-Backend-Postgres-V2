// Purpose: Exposes the Leave Tracker's month-grid and balance-strip endpoints, plus their Excel/PDF exports.
// Responsibilities: Validates DTOs and delegates all logic to LeaveTrackerService.
// Important: Entire controller is gated to ADMIN/HR/MANAGER; MANAGER's forced own-department scoping is
// enforced in the service, not here.
import { Controller, Get, Inject, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { LeaveTrackerService } from './leave-tracker.service';
import { QueryLeaveTrackerGridDto } from './dto/query-leave-tracker-grid.dto';
import { QueryLeaveTrackerBalancesDto } from './dto/query-leave-tracker-balances.dto';
import { ExportLeaveTrackerGridDto } from './dto/export-leave-tracker-grid.dto';
import { ExportLeaveTrackerBalancesDto } from './dto/export-leave-tracker-balances.dto';
import { sendReportBranded } from '../reports/report-branding';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
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
  constructor(
    private readonly leaveTrackerService: LeaveTrackerService,
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

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

  @Get('grid/export')
  async exportGrid(
    @Query() query: ExportLeaveTrackerGridDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.leaveTrackerService.exportGrid(
      query,
      caller,
      caller.organizationId,
    );
    await sendReportBranded(res, this.scopedPrisma, caller.organizationId, {
      ...report,
      format: query.format ?? 'xlsx',
    });
  }

  @Get('balances/export')
  async exportBalances(
    @Query() query: ExportLeaveTrackerBalancesDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.leaveTrackerService.exportBalances(
      query,
      caller,
      caller.organizationId,
    );
    await sendReportBranded(res, this.scopedPrisma, caller.organizationId, {
      ...report,
      format: query.format ?? 'xlsx',
    });
  }
}
