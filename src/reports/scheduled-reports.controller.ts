// Purpose: Admin/HR screens' API for reports emailed on a schedule.
// Responsibilities: list the schedulable reports, and create / edit / pause / delete / send-now a schedule.
// Important: Admin and HR only (reports can carry salary, tax and attendance data and are emailed outside the app).
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ScheduledReportsService } from './scheduled-reports.service';
import {
  CreateScheduledReportDto,
  UpdateScheduledReportDto,
} from './dto/scheduled-report.dto';

type Caller = Omit<User, 'password'>;

@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('reports/scheduled')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
export class ScheduledReportsController {
  constructor(private readonly service: ScheduledReportsService) {}

  @Get('options')
  options() {
    return this.service.options();
  }

  @Get()
  list(@CurrentUser() c: Caller) {
    return this.service.list(c.organizationId);
  }

  @Post()
  create(@Body() dto: CreateScheduledReportDto, @CurrentUser() c: Caller) {
    return this.service.create(dto, c, c.organizationId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateScheduledReportDto,
    @CurrentUser() c: Caller,
  ) {
    return this.service.update(id, dto, c, c.organizationId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() c: Caller) {
    return this.service.remove(id, c, c.organizationId);
  }

  @Post(':id/run')
  run(@Param('id') id: string, @CurrentUser() c: Caller) {
    return this.service.runNow(id, c, c.organizationId);
  }
}
