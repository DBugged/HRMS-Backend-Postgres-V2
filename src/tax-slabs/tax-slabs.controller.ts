// Purpose: Exposes CRUD for income-tax slab definitions plus a lookup of system default slabs by regime.
// Responsibilities: Validates DTOs/params (including regime enum checks) and delegates all logic to TaxSlabsService.
// Important: Entire controller is gated to ADMIN/HR.
import {
  BadRequestException,
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
import { Role, TaxRegime, User } from '@prisma/client';
import { TaxSlabsService } from './tax-slabs.service';
import { UpsertTaxSlabDto } from './dto/upsert-tax-slab.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('tax-slabs')
@ApiBearerAuth('access-token')
@Controller('tax-slabs')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
export class TaxSlabsController {
  constructor(private readonly taxSlabsService: TaxSlabsService) {}

  @Get('defaults')
  getDefaults(@Query('regime') regime: string) {
    const upper = regime?.toUpperCase();
    if (upper !== TaxRegime.OLD && upper !== TaxRegime.NEW) {
      throw new BadRequestException("regime must be 'old' or 'new'.");
    }
    return this.taxSlabsService.getDefaults(upper);
  }

  @Get()
  findAll(
    @Query('financialYear') financialYear: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.taxSlabsService.findAll(financialYear, caller.organizationId);
  }

  @Post()
  upsert(@Body() dto: UpsertTaxSlabDto, @CurrentUser() caller: Caller) {
    return this.taxSlabsService.upsert(dto, caller.organizationId, caller.id);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.taxSlabsService.remove(id, caller.organizationId, caller.id);
  }
}
