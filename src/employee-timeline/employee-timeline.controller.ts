import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role, User } from '@prisma/client';
import { EmployeeTimelineService } from './employee-timeline.service';
import { QueryTimelineDto } from './dto/query-timeline.dto';
import { TIMELINE_CATEGORIES } from './timeline-events';
import { sendReport } from '../reports/report-export';
import { SelfOrRoles } from '../common/decorators/self-or-roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';

type Caller = Omit<User, 'password'>;

// Mounted at /employees/:id/timeline — same self-or-role view-scoping as
// GET /employees/:id (self, or ADMIN/HR/MANAGER — MANAGER further
// restricted to their own department inside the service).
@ApiTags('employee-timeline')
@ApiBearerAuth('access-token')
@Controller('employees/:id/timeline')
export class EmployeeTimelineController {
  constructor(private readonly timelineService: EmployeeTimelineService) {}

  @Get()
  @SelfOrRoles('id', Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  async findAll(
    @Param('id') id: string,
    @Query() query: QueryTimelineDto,
    @CurrentUser() caller: Caller,
  ) {
    const result = await this.timelineService.findAll(
      id,
      query,
      caller,
      caller.organizationId,
    );
    return { ...result, categories: TIMELINE_CATEGORIES };
  }

  @Get('export/excel')
  @SelfOrRoles('id', Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async exportExcel(
    @Param('id') id: string,
    @Query() query: QueryTimelineDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const { employee, events } = await this.timelineService.fetchForExport(
      id,
      query,
      caller,
      caller.organizationId,
    );
    await sendReport(res, {
      title: 'Employee Timeline',
      columns: [
        { header: 'Date & Time', key: 'occurredAt', width: 22 },
        { header: 'Category', key: 'category', width: 18 },
        { header: 'Event', key: 'title', width: 30 },
        { header: 'Description', key: 'description', width: 40 },
        { header: 'Performed By', key: 'performedBy', width: 22 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Remarks', key: 'remarks', width: 30 },
      ],
      rows: events.map((e) => ({
        occurredAt: e.occurredAt.toLocaleString(),
        category: e.category,
        title: e.title,
        description: e.description ?? '',
        performedBy: e.performedBy?.name ?? 'System',
        status: e.status ?? '',
        remarks: e.remarks ?? '',
      })),
      filename: `${employee.employeeId}-timeline`,
      format: 'xlsx',
    });
  }

  @Get('export/pdf')
  @SelfOrRoles('id', Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async exportPdf(
    @Param('id') id: string,
    @Query() query: QueryTimelineDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const { employee, events } = await this.timelineService.fetchForExport(
      id,
      query,
      caller,
      caller.organizationId,
    );
    await sendReport(res, {
      title: `Employee Timeline — ${employee.name} (${employee.employeeId})`,
      columns: [
        { header: 'Date & Time', key: 'occurredAt', width: 22 },
        { header: 'Category', key: 'category', width: 18 },
        { header: 'Event', key: 'title', width: 30 },
        { header: 'Description', key: 'description', width: 40 },
        { header: 'Performed By', key: 'performedBy', width: 22 },
        { header: 'Status', key: 'status', width: 14 },
        { header: 'Remarks', key: 'remarks', width: 30 },
      ],
      rows: events.map((e) => ({
        occurredAt: e.occurredAt.toLocaleString(),
        category: e.category,
        title: e.title,
        description: e.description ?? '',
        performedBy: e.performedBy?.name ?? 'System',
        status: e.status ?? '',
        remarks: e.remarks ?? '',
      })),
      filename: `${employee.employeeId}-timeline`,
      format: 'pdf',
    });
  }
}
