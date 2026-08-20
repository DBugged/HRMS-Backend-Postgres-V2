// Purpose: Exposes endpoints for employee loans — creation, status updates, and repayment recording/listing.
// Responsibilities: Validates DTOs and delegates all logic to LoansService.
// Important: Loans are always initiated by ADMIN/HR on an employee's behalf, not self-service; reads self-scope in the service.
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { LoansService } from './loans.service';
import { CreateLoanDto } from './dto/create-loan.dto';
import { UpdateLoanStatusDto } from './dto/update-loan-status.dto';
import { RecordRepaymentDto } from './dto/record-repayment.dto';
import { QueryLoanDto } from './dto/query-loan.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('loans')
@ApiBearerAuth('access-token')
@Controller('loans')
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  // No @Roles() — any authenticated caller (self-scoped for EMPLOYEE,
  // service-side).
  @Get()
  findAll(@Query() query: QueryLoanDto, @CurrentUser() caller: Caller) {
    return this.loansService.findAll(query, caller, caller.organizationId);
  }

  // Old system's PAYROLL_CONFIG_ROLES collapses to [ADMIN, HR], same
  // convention used throughout Payroll/Reimbursements — loans are always
  // initiated by HR/admin on an employee's behalf, not self-service.
  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateLoanDto, @CurrentUser() caller: Caller) {
    return this.loansService.create(dto, caller, caller.organizationId);
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateLoanStatusDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.loansService.updateStatus(id, dto, caller.organizationId);
  }

  @Post(':id/repayments')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  recordRepayment(
    @Param('id') id: string,
    @Body() dto: RecordRepaymentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.loansService.recordRepayment(id, dto, caller.organizationId);
  }

  // No @Roles() — self-scoped inline in the service (403 if an EMPLOYEE
  // requests a loan that isn't theirs), same idiom as the payroll
  // single-payslip GET.
  @Get(':id/repayments')
  getRepayments(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.loansService.getRepayments(id, caller, caller.organizationId);
  }
}
