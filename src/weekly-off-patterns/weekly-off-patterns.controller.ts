// Purpose: Exposes CRUD for the standalone Weekly Off pattern reference catalog.
// Important: findAll has no @Roles() — any authenticated caller, same convention as Departments/
// OrgListItems/WorkSchedules/Shifts; writes are ADMIN/HR.
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
import { WeeklyOffPatternsService } from './weekly-off-patterns.service';
import { CreateWeeklyOffPatternDto } from './dto/create-weekly-off-pattern.dto';
import { UpdateWeeklyOffPatternDto } from './dto/update-weekly-off-pattern.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('weekly-off-patterns')
@ApiBearerAuth('access-token')
@Controller('weekly-off-patterns')
export class WeeklyOffPatternsController {
  constructor(private readonly weeklyOffPatternsService: WeeklyOffPatternsService) {}

  @Get()
  findAll(@CurrentUser() caller: Caller) {
    return this.weeklyOffPatternsService.findAll(caller.organizationId);
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateWeeklyOffPatternDto, @CurrentUser() caller: Caller) {
    return this.weeklyOffPatternsService.create(dto, caller.organizationId, caller);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateWeeklyOffPatternDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.weeklyOffPatternsService.update(id, dto, caller.organizationId, caller);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.weeklyOffPatternsService.delete(id, caller.organizationId, caller);
  }
}
