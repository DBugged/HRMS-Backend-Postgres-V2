// Purpose: HR/Admin endpoints for the company / department achievement % that scales variable pay.
// Important: Admin and HR only — this directly changes what employees are paid.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { CompanyPerformanceService } from './company-performance.service';
import { SetCompanyPerformanceDto } from './dto/set-company-performance.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('company-performance')
@ApiBearerAuth('access-token')
@Controller('company-performance')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
export class CompanyPerformanceController {
  constructor(private readonly service: CompanyPerformanceService) {}

  @Get()
  findAll(
    @Query('financialYear') financialYear: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.service.findAll(caller.organizationId, financialYear);
  }

  // Whose variable pay is on hold, waiting for a percentage.
  @Get('held')
  held(@CurrentUser() caller: Caller) {
    return this.service.held(caller.organizationId);
  }

  @Put()
  set(@Body() dto: SetCompanyPerformanceDto, @CurrentUser() caller: Caller) {
    return this.service.set(dto, caller.id, caller.organizationId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.service.remove(id, caller.id, caller.organizationId);
  }
}
