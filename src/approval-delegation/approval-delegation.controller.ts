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
import { ApprovalDelegationService } from './approval-delegation.service';
import { CreateDelegationDto } from './dto/create-delegation.dto';
import { QueryDelegationDto } from './dto/query-delegation.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

// Only roles that can ever be an approver can create/view delegations —
// scoped to self inside the service unless the caller is ADMIN/HR.
@ApiTags('approval-delegation')
@ApiBearerAuth('access-token')
@Controller('delegations')
@Roles(Role.ADMIN, Role.HR, Role.MANAGER)
@UseGuards(RolesGuard)
export class ApprovalDelegationController {
  constructor(private readonly delegationService: ApprovalDelegationService) {}

  @Get()
  findMine(@Query() query: QueryDelegationDto, @CurrentUser() caller: Caller) {
    return this.delegationService.findMine(
      query,
      caller,
      caller.organizationId,
    );
  }

  @Post()
  create(@Body() dto: CreateDelegationDto, @CurrentUser() caller: Caller) {
    return this.delegationService.create(dto, caller, caller.organizationId);
  }

  @Patch(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.delegationService.cancel(id, caller, caller.organizationId);
  }
}
