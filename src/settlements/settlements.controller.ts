import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { SettlementsService } from './settlements.service';
import { CalculateSettlementDto } from './dto/calculate-settlement.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

// Old system's PAYROLL_APPROVE_ROLES collapses to [ADMIN, HR], same
// convention used throughout Payroll/Reimbursements/Loans.
@ApiTags('settlements')
@ApiBearerAuth('access-token')
@Controller('settlements')
export class SettlementsController {
  constructor(private readonly settlementsService: SettlementsService) {}

  // No @Roles() — any authenticated caller (self-scoped for EMPLOYEE,
  // service-side).
  @Get()
  findAll(@CurrentUser() caller: Caller) {
    return this.settlementsService.findAll(caller, caller.organizationId);
  }

  @Post('calculate')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  calculate(
    @Body() dto: CalculateSettlementDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.settlementsService.calculate(
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Post(':id/process')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  process(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.settlementsService.process(id, caller, caller.organizationId);
  }

  @Post(':id/pay')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  markPaid(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.settlementsService.markPaid(id, caller, caller.organizationId);
  }
}
