// Purpose: Exposes CRUD + department assignment for named Work Schedule templates.
// Responsibilities: Validates DTOs and delegates to WorkSchedulesService.
// Important: findAll has no @Roles() — any authenticated caller (dropdowns/visibility), same convention
// as Departments/OrgListItems; writes are ADMIN/HR.
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
import { WorkSchedulesService } from './work-schedules.service';
import { CreateWorkScheduleDto } from './dto/create-work-schedule.dto';
import { UpdateWorkScheduleDto } from './dto/update-work-schedule.dto';
import { AssignWorkScheduleDto } from './dto/assign-work-schedule.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('work-schedules')
@ApiBearerAuth('access-token')
@Controller('work-schedules')
export class WorkSchedulesController {
  constructor(private readonly workSchedulesService: WorkSchedulesService) {}

  @Get()
  findAll(@CurrentUser() caller: Caller) {
    return this.workSchedulesService.findAll(caller.organizationId);
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateWorkScheduleDto, @CurrentUser() caller: Caller) {
    return this.workSchedulesService.create(dto, caller.organizationId, caller);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWorkScheduleDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.workSchedulesService.update(id, dto, caller.organizationId, caller);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.workSchedulesService.delete(id, caller.organizationId, caller);
  }

  @Post(':id/assign')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  assign(
    @Param('id') id: string,
    @Body() dto: AssignWorkScheduleDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.workSchedulesService.assign(id, dto, caller.organizationId, caller);
  }
}
