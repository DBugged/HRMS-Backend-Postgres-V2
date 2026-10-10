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
import { LeaveGrantRequestsService } from './leave-grant-requests.service';
import {
  ApproveGrantRequestDto,
  CreateGrantRequestDto,
  CreateLeaveGrantDto,
  QueryGrantRequestsDto,
  QueryLeaveGrantsDto,
  RejectGrantRequestDto,
  ReverseLeaveGrantDto,
} from './dto/leave-grant.dto';

type Caller = Omit<User, 'password'>;

@ApiTags('leave-grants')
@ApiBearerAuth('access-token')
@Controller('leave-grants')
export class LeaveGrantsController {
  constructor(
    private readonly service: LeaveGrantsService,
    private readonly requests: LeaveGrantRequestsService,
  ) {}

  // Static `requests` routes come before the `:id` route so Nest does not read "requests" as an id.
  // No @Roles(): any employee lists their own requests (HR/Admin see everyone's) and files one for themselves.
  @Get('requests')
  listRequests(
    @Query() query: QueryGrantRequestsDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.requests.list(query, caller, caller.organizationId);
  }

  @Post('requests')
  createRequest(
    @Body() dto: CreateGrantRequestDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.requests.create(dto, caller, caller.organizationId);
  }

  @Post('requests/:id/cancel')
  cancelRequest(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.requests.cancel(id, caller, caller.organizationId);
  }

  // Decided by a manager (their team), HR or Admin, following the leave type's Approval Levels.
  @Post('requests/:id/approve')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  approveRequest(
    @Param('id') id: string,
    @Body() dto: ApproveGrantRequestDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.requests.approve(id, dto, caller, caller.organizationId);
  }

  @Post('requests/:id/reject')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  rejectRequest(
    @Param('id') id: string,
    @Body() dto: RejectGrantRequestDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.requests.reject(id, dto, caller, caller.organizationId);
  }

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
