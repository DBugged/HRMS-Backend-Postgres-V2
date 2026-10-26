// Purpose: the Organization health API - setup progress, settings that contradict each other, and leavers who still lead people.
// Important: ADMIN/HR only; read-only (fixing uses the existing reassign-reports and assign-head actions).
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { OrgHealthService } from './org-health.service';

type Caller = Omit<User, 'password'>;

@ApiTags('org-health')
@ApiBearerAuth('access-token')
@Controller('org-health')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
export class OrgHealthController {
  constructor(private readonly service: OrgHealthService) {}

  @Get()
  get(@CurrentUser() caller: Caller) {
    return this.service.get(caller.organizationId);
  }
}
