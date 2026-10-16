// Purpose: Opening balances API - the year so far for a company that starts payroll partway through the FY.
// Responsibilities: validates input and delegates to OpeningBalancesService. ADMIN/HR only.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { OpeningBalancesService } from './opening-balances.service';
import {
  OpeningBalanceDto,
  OpeningBalanceImportDto,
  OpeningBalanceQueryDto,
} from './dto/opening-balance.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('payroll')
@ApiBearerAuth('access-token')
@Controller('opening-balances')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
export class OpeningBalancesController {
  constructor(private readonly service: OpeningBalancesService) {}

  @Get()
  list(@Query() q: OpeningBalanceQueryDto, @CurrentUser() c: Caller) {
    return this.service.list(c.organizationId, q.month, q.year);
  }

  @Post('import')
  import(
    @Body() dto: OpeningBalanceImportDto,
    @Query() q: OpeningBalanceQueryDto,
    @CurrentUser() c: Caller,
  ) {
    return this.service.importRows(
      dto.rows,
      c,
      c.organizationId,
      q.month,
      q.year,
    );
  }

  @Get('employee/:id')
  get(
    @Param('id') id: string,
    @Query() q: OpeningBalanceQueryDto,
    @CurrentUser() c: Caller,
  ) {
    return this.service.get(id, c.organizationId, q.month, q.year);
  }

  @Put('employee/:id')
  set(
    @Param('id') id: string,
    @Body() dto: OpeningBalanceDto,
    @Query() q: OpeningBalanceQueryDto,
    @CurrentUser() c: Caller,
  ) {
    return this.service.set(id, dto, c, c.organizationId, q.month, q.year);
  }

  @Delete('employee/:id')
  clear(
    @Param('id') id: string,
    @Query() q: OpeningBalanceQueryDto,
    @CurrentUser() c: Caller,
  ) {
    return this.service.clear(id, c, c.organizationId, q.month, q.year);
  }
}
