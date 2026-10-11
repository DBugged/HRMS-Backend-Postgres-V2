// Purpose: The organisation's leave year (the period a leave balance belongs to) and its one-off transition.
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { LeaveYearService } from './leave-year.service';
import { TransitionLeaveYearDto } from './dto/transition-leave-year.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';

type Caller = Omit<User, 'password'>;

@ApiTags('leave-year')
@ApiBearerAuth('access-token')
@Controller('leave-year')
export class LeaveYearController {
  constructor(private readonly leaveYearService: LeaveYearService) {}

  // No @Roles(): every employee sees which leave year their balance belongs to.
  @Get()
  get(@CurrentUser() caller: Caller) {
    return this.leaveYearService.get(caller.organizationId);
  }

  // Admin only; send dryRun to preview what it would change.
  @Post('transition')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  transition(
    @Body() dto: TransitionLeaveYearDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leaveYearService.transition(dto, caller, caller.organizationId);
  }
}
