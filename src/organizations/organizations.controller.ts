import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { OrganizationsService } from './organizations.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// The RBAC "proof endpoint" for this phase — mirrors the old Express
// backend's real GET /api/organization (authorize('administrator') only),
// extended to Admin+HR here so the RBAC check actually exercises an
// allow/deny boundary between two roles rather than a single-role check.
@ApiTags('organizations')
@ApiBearerAuth('access-token')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get('me')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  findOwn(@CurrentUser() user: { organizationId: string }) {
    return this.organizationsService.findOwn(user.organizationId);
  }

  @Patch('me')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updateOwn(
    @CurrentUser() user: { organizationId: string },
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.updateOwn(user.organizationId, dto);
  }
}
