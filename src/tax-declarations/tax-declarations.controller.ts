// Purpose: Exposes endpoints to fetch and upsert an employee's investment/tax declaration for a financial year.
// Responsibilities: Validates DTOs and delegates all logic to TaxDeclarationsService.
// Important: No @Roles() anywhere — access is identity-based (self-vs-other) in the service, not role-based.
import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { TaxDeclarationsService } from './tax-declarations.service';
import { UpsertTaxDeclarationDto } from './dto/upsert-tax-declaration.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { SetTaxRegimeDto } from './dto/set-tax-regime.dto';

type Caller = Omit<User, 'password'>;

// No @Roles() — any authenticated caller. Access control is identity-based
// (see TaxDeclarationsService), not role-based, matching the original release's
// deliberate design (self-vs-other, not employee-role-vs-other).
@ApiTags('tax-declarations')
@ApiBearerAuth('access-token')
@Controller('tax-declarations')
export class TaxDeclarationsController {
  constructor(
    private readonly taxDeclarationsService: TaxDeclarationsService,
  ) {}

  // The financial years a declaration can be filed for. Declared before the bare GET so the web and mobile year
  // pickers read one list instead of each working it out from the device date.
  @Get('financial-years')
  financialYears(@CurrentUser() caller: Caller) {
    return this.taxDeclarationsService.financialYears(caller.organizationId);
  }

  @Get()
  get(
    @Query('employeeId') employeeId: string | undefined,
    @Query('financialYear') financialYear: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.taxDeclarationsService.get(
      employeeId,
      financialYear,
      caller,
      caller.organizationId,
    );
  }

  @Post()
  upsert(@Body() dto: UpsertTaxDeclarationDto, @CurrentUser() caller: Caller) {
    return this.taxDeclarationsService.upsert(
      dto,
      caller,
      caller.organizationId,
    );
  }

  // HR / Admin: set the tax regime of one employee or many. Never uses up the employee's own once-a-year change.
  @Post('regime')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  setRegime(@Body() dto: SetTaxRegimeDto, @CurrentUser() caller: Caller) {
    return this.taxDeclarationsService.setRegimeForEmployees(
      dto,
      caller,
      caller.organizationId,
    );
  }
}
