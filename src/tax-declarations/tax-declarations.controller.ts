// Purpose: Exposes endpoints to fetch and upsert an employee's investment/tax declaration for a financial year.
// Responsibilities: Validates DTOs and delegates all logic to TaxDeclarationsService.
// Important: No @Roles() anywhere — access is identity-based (self-vs-other) in the service, not role-based.
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { TaxDeclarationsService } from './tax-declarations.service';
import { UpsertTaxDeclarationDto } from './dto/upsert-tax-declaration.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

// No @Roles() — any authenticated caller. Access control is identity-based
// (see TaxDeclarationsService), not role-based, matching the old system's
// deliberate design (self-vs-other, not employee-role-vs-other).
@ApiTags('tax-declarations')
@ApiBearerAuth('access-token')
@Controller('tax-declarations')
export class TaxDeclarationsController {
  constructor(
    private readonly taxDeclarationsService: TaxDeclarationsService,
  ) {}

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
}
