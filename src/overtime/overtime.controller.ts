// Purpose: Exposes endpoints to log, list, and review overtime entries.
// Responsibilities: Validates DTOs and delegates all logic to OvertimeService.
// Important: Only review is gated to ADMIN/HR/MANAGER; findAll/log have no @Roles() and self-scope for EMPLOYEE in the service.
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
import { OvertimeService } from './overtime.service';
import { LogOvertimeDto } from './dto/log-overtime.dto';
import { ReviewOvertimeDto } from './dto/review-overtime.dto';
import { QueryOvertimeDto } from './dto/query-overtime.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('overtime')
@ApiBearerAuth('access-token')
@Controller('overtime')
export class OvertimeController {
  constructor(private readonly overtimeService: OvertimeService) {}

  // No @Roles() — any authenticated caller can view (self-scoped for
  // EMPLOYEE, service-side).
  @Get()
  findAll(@Query() query: QueryOvertimeDto, @CurrentUser() caller: Caller) {
    return this.overtimeService.findAll(query, caller, caller.organizationId);
  }

  // No @Roles() — any authenticated caller logs their own overtime only.
  @Post()
  log(@Body() dto: LogOvertimeDto, @CurrentUser() caller: Caller) {
    return this.overtimeService.log(dto, caller, caller.organizationId);
  }

  @Patch(':id/review')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  review(
    @Param('id') id: string,
    @Body() dto: ReviewOvertimeDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.overtimeService.review(id, dto, caller, caller.organizationId);
  }
}
