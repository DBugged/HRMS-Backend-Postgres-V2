// Purpose: Exposes full-and-final settlement endpoints — calculate, process, and mark paid.
// Responsibilities: Validates DTOs and delegates all logic to SettlementsService.
// Important: calculate/process/pay are gated to ADMIN/HR; findAll has no @Roles() and self-scopes for EMPLOYEE in the service.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { SettlementsService } from './settlements.service';
import { CalculateSettlementDto } from './dto/calculate-settlement.dto';
import { ReverseSettlementDto } from './dto/reverse-settlement.dto';
import { MarkSettlementPaidDto } from './dto/mark-settlement-paid.dto';
import { CloseReceivableDto } from './dto/close-receivable.dto';
import { ListSettlementsQueryDto } from './dto/list-settlements-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

// The original release's PAYROLL_APPROVE_ROLES collapses to [ADMIN, HR], same
// convention used throughout Payroll/Reimbursements/Loans.
@ApiTags('settlements')
@ApiBearerAuth('access-token')
@Controller('settlements')
export class SettlementsController {
  constructor(private readonly settlementsService: SettlementsService) {}

  // No @Roles() — any authenticated caller (self-scoped for EMPLOYEE,
  // service-side).
  @Get()
  findAll(
    @Query() query: ListSettlementsQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.settlementsService.findAll(
      query,
      caller,
      caller.organizationId,
    );
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

  // Admin only: reopens a processed (unpaid) settlement for correction.
  @Post(':id/reverse')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  reverse(
    @Param('id') id: string,
    @Body() dto: ReverseSettlementDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.settlementsService.reverse(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }

  // What the employee still owes after the settlement (recoveries above the payout): HR records it as received, only an
  // Admin can waive it.
  @Post(':id/receivable')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  closeReceivable(
    @Param('id') id: string,
    @Body() dto: CloseReceivableDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.settlementsService.closeReceivable(
      id,
      dto.outcome,
      dto.note,
      caller,
      caller.organizationId,
    );
  }

  // Deletes a DRAFT only (a preview for the wrong employee or date); processed / paid settlements are refused.
  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  discardDraft(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.settlementsService.discardDraft(
      id,
      caller,
      caller.organizationId,
    );
  }

  @Post(':id/pay')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  markPaid(
    @Param('id') id: string,
    @Body() dto: MarkSettlementPaidDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.settlementsService.markPaid(
      id,
      caller,
      caller.organizationId,
      dto,
    );
  }
}
