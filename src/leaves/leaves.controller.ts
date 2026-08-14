import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { LeavesService } from './leaves.service';
import { ApplyLeaveDto } from './dto/apply-leave.dto';
import { UpdateLeaveDto } from './dto/update-leave.dto';
import { ReviewLeaveDto } from './dto/review-leave.dto';
import { ListLeavesQueryDto } from './dto/list-leaves-query.dto';
import { TeamCalendarQueryDto } from './dto/team-calendar-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('leaves')
@ApiBearerAuth('access-token')
@Controller('leaves')
export class LeavesController {
  constructor(private readonly leavesService: LeavesService) {}

  @Post()
  apply(@Body() dto: ApplyLeaveDto, @CurrentUser() caller: Caller) {
    return this.leavesService.apply(dto, caller, caller.organizationId);
  }

  @Get()
  findAll(@Query() query: ListLeavesQueryDto, @CurrentUser() caller: Caller) {
    return this.leavesService.findAll(query, caller, caller.organizationId);
  }

  @Get('balance')
  balance(
    @Query('employeeId') employeeId: string | undefined,
    @Query('year') year: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.leavesService.getBalance(
      employeeId,
      year ? Number(year) : undefined,
      caller,
      caller.organizationId,
    );
  }

  @Get('team-calendar')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  teamCalendar(
    @Query() query: TeamCalendarQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leavesService.getTeamCalendar(
      query,
      caller,
      caller.organizationId,
    );
  }

  @Get('history/:employeeId')
  history(
    @Param('employeeId') employeeId: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.leavesService.getHistory(
      employeeId,
      caller,
      caller.organizationId,
    );
  }

  @Put(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLeaveDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leavesService.update(id, dto, caller, caller.organizationId);
  }

  @Patch(':id/review')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  review(
    @Param('id') id: string,
    @Body() dto: ReviewLeaveDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leavesService.review(id, dto, caller, caller.organizationId);
  }

  @Patch(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.leavesService.cancel(id, caller, caller.organizationId);
  }
}
