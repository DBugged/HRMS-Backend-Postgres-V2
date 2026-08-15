import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { LeaveTypesService } from './leave-types.service';
import { CreateLeaveTypeDto } from './dto/create-leave-type.dto';
import { UpdateLeaveTypeDto } from './dto/update-leave-type.dto';
import { RunCarryForwardDto } from './dto/run-carry-forward.dto';
import { ListLeaveTypesQueryDto } from './dto/list-leave-types-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('leave-types')
@ApiBearerAuth('access-token')
@Controller('leave-types')
export class LeaveTypesController {
  constructor(private readonly leaveTypesService: LeaveTypesService) {}

  // Static routes registered before the `:id` routes below, same reason as
  // Holidays' bulk-import (Nest would otherwise try to match "eligible" and
  // "run-carry-forward" as a route param).
  @Get('eligible/me')
  eligibleForMe(@CurrentUser() caller: Caller) {
    return this.leaveTypesService.getEligibleForMe(
      caller.id,
      caller.organizationId,
    );
  }

  @Post('run-carry-forward')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  runCarryForward(
    @Body() dto: RunCarryForwardDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leaveTypesService.runCarryForward(
      dto,
      caller.id,
      caller.organizationId,
    );
  }

  @Get()
  findAll(
    @Query() query: ListLeaveTypesQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leaveTypesService.findAll(
      caller.organizationId,
      query.activeOnly,
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.leaveTypesService.findOne(id, caller.organizationId);
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateLeaveTypeDto, @CurrentUser() caller: Caller) {
    return this.leaveTypesService.create(dto, caller.organizationId, caller.id);
  }

  @Put(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLeaveTypeDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leaveTypesService.update(id, dto, caller.organizationId);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.leaveTypesService.remove(id, caller.organizationId);
  }

  @Post(':id/run-accrual')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  runAccrual(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.leaveTypesService.runAccrual(
      id,
      caller.id,
      caller.organizationId,
    );
  }
}
