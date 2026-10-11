import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { LeaveBalanceAdjustmentService } from './leave-balance-adjustment.service';
import { AdjustLeaveBalanceDto } from './dto/adjust-leave-balance.dto';

type Caller = Omit<User, 'password'>;

@ApiTags('leave-balances')
@ApiBearerAuth('access-token')
@Controller('leave-balances')
export class LeaveBalancesController {
  constructor(private readonly adjustment: LeaveBalanceAdjustmentService) {}

  // Manual correction of one balance, with a mandatory reason; audited. HR/Admin only.
  @Post('adjust')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  adjust(@Body() dto: AdjustLeaveBalanceDto, @CurrentUser() caller: Caller) {
    return this.adjustment.adjust(dto, caller, caller.organizationId);
  }
}
