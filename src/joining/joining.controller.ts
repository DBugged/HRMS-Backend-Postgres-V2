// Purpose: the joining checklist API - the tracker for HR and managers, a person's own open tasks, and ticking / reassigning a step.
// Important: ADMIN/HR see everyone, a MANAGER their own team and the steps they own; an owner can tick only their own steps (the
//   service enforces it). 'mine' is declared before the :employeeId routes so it is not read as an id.
import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JoiningChecklistService } from './joining-checklist.service';
import { UpdateJoiningItemDto } from './dto/update-joining-item.dto';

type Caller = Omit<User, 'password'>;

@ApiTags('joining-checklists')
@ApiBearerAuth('access-token')
@Controller('joining-checklists')
@Roles(Role.ADMIN, Role.HR, Role.MANAGER)
@UseGuards(RolesGuard)
export class JoiningController {
  constructor(private readonly service: JoiningChecklistService) {}

  @Get()
  overview(@CurrentUser() caller: Caller) {
    return this.service.overview(caller, caller.organizationId);
  }

  @Get('mine')
  mine(@CurrentUser() caller: Caller) {
    return this.service.mine(caller, caller.organizationId);
  }

  @Patch(':employeeId/items/:key')
  updateItem(
    @Param('employeeId') employeeId: string,
    @Param('key') key: string,
    @Body() dto: UpdateJoiningItemDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.service.updateItem(employeeId, key, dto, caller, caller.organizationId);
  }
}
