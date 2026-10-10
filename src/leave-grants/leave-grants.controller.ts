// Purpose: Endpoints to grant, list and reverse event-based leave. Granting and reversing are ADMIN/HR only; listing is
//   self-scoped for everyone else (service-side).
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { LeaveGrantsService } from './leave-grants.service';
import {
  CreateLeaveGrantDto,
  QueryLeaveGrantsDto,
  ReverseLeaveGrantDto,
} from './dto/leave-grant.dto';

type Caller = Omit<User, 'password'>;

@ApiTags('leave-grants')
@ApiBearerAuth('access-token')
@Controller('leave-grants')
export class LeaveGrantsController {
  constructor(private readonly service: LeaveGrantsService) {}

  @Get()
  list(@Query() query: QueryLeaveGrantsDto, @CurrentUser() caller: Caller) {
    return this.service.list(query, caller, caller.organizationId);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.HR)
  grant(@Body() dto: CreateLeaveGrantDto, @CurrentUser() caller: Caller) {
    return this.service.grant(dto, caller, caller.organizationId);
  }

  @Post(':id/reverse')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.HR)
  reverse(
    @Param('id') id: string,
    @Body() dto: ReverseLeaveGrantDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.service.reverse(id, dto, caller, caller.organizationId);
  }
}
