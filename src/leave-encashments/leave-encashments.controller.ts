// Purpose: Exposes endpoints to request, list, and review leave-encashment requests.
// Responsibilities: Validates DTOs and delegates all logic to LeaveEncashmentsService.
// Important: Only review is gated to ADMIN/HR/MANAGER; findAll/request have no @Roles() and self-scope for EMPLOYEE in the service.
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
import { LeaveEncashmentsService } from './leave-encashments.service';
import { RequestLeaveEncashmentDto } from './dto/request-leave-encashment.dto';
import { ReviewLeaveEncashmentDto } from './dto/review-leave-encashment.dto';
import { QueryLeaveEncashmentDto } from './dto/query-leave-encashment.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('leave-encashments')
@ApiBearerAuth('access-token')
@Controller('leave-encashments')
export class LeaveEncashmentsController {
  constructor(
    private readonly leaveEncashmentsService: LeaveEncashmentsService,
  ) {}

  // No @Roles() — any authenticated caller (self-scoped for EMPLOYEE,
  // service-side).
  @Get()
  findAll(
    @Query() query: QueryLeaveEncashmentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leaveEncashmentsService.findAll(
      query,
      caller,
      caller.organizationId,
    );
  }

  // No @Roles() — any authenticated caller requests for themselves only.
  @Post()
  request(
    @Body() dto: RequestLeaveEncashmentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leaveEncashmentsService.request(
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Patch(':id/review')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  review(
    @Param('id') id: string,
    @Body() dto: ReviewLeaveEncashmentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.leaveEncashmentsService.review(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }
}
