// Purpose: Exposes get/update endpoints for the organization's payroll settings (pay cycle dates, etc.).
// Responsibilities: Validates the update DTO and delegates to PayrollSettingsService, which resolves cycle dates.
// Important: Entire controller is gated to ADMIN/HR.
import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { PayrollSettingsService } from './payroll-settings.service';
import { UpdatePayrollSettingsDto } from './dto/update-payroll-settings.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('payroll-settings')
@ApiBearerAuth('access-token')
@Controller('payroll-settings')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
export class PayrollSettingsController {
  constructor(
    private readonly payrollSettingsService: PayrollSettingsService,
  ) {}

  @Get()
  get(@CurrentUser() caller: Caller) {
    return this.payrollSettingsService.getWithResolvedDates(
      caller.organizationId,
    );
  }

  @Put()
  update(@Body() dto: UpdatePayrollSettingsDto, @CurrentUser() caller: Caller) {
    return this.payrollSettingsService.update(
      dto,
      caller.id,
      caller.organizationId,
    );
  }
}
