// Purpose: Admin-only endpoint behind the Access Control page's "Actions" view.
import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AccessControlService } from './access-control.service';

@ApiTags('access-control')
@ApiBearerAuth('access-token')
@Controller('access-control')
export class AccessControlController {
  constructor(private readonly service: AccessControlService) {}

  // Role counts, the Admin and HR accounts, and the latest role changes.
  @Get('people')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  people(@CurrentUser() caller: { organizationId: string }) {
    return this.service.people(caller.organizationId);
  }

  // Every API route with who may call it, read from the route decorators themselves.
  @Get('actions')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  actions() {
    const routes = this.service.routes();
    return { total: routes.length, data: routes };
  }
}
