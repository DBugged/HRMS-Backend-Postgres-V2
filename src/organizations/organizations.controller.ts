import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { OrganizationsService } from './organizations.service';
import { OrganizationSettingsService } from './organization-settings.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

// The RBAC "proof endpoint" for this phase — mirrors the old Express
// backend's real GET /api/organization (authorize('administrator') only),
// extended to Admin+HR here so the RBAC check actually exercises an
// allow/deny boundary between two roles rather than a single-role check.
@ApiTags('organizations')
@ApiBearerAuth('access-token')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly organizationSettingsService: OrganizationSettingsService,
  ) {}

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

  // -- Setup Wizard / Organization Settings --
  // Old system's route restriction is administrator-only for all of this
  // except /public (any authenticated) — despite stale comments elsewhere
  // claiming HR can view; the actual enforced behavior is ADMIN-only,
  // ported as-is.

  @Get('settings/public')
  getPublicBranding(@CurrentUser() caller: Caller) {
    return this.organizationSettingsService.getPublicBranding(
      caller.organizationId,
    );
  }

  @Get('settings')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  getSettings(@CurrentUser() caller: Caller) {
    return this.organizationSettingsService.getFull(
      caller.organizationId,
      caller,
    );
  }

  // Body shape varies per section (flat strings for some, full JSON blobs
  // for others) — real whitelisting happens server-side in
  // OrganizationSettingsService against SECTION_FIELDS, same as the old
  // system, so this deliberately takes a plain object rather than a typed
  // DTO (a class-validator DTO would need one shape per section).
  @Patch('settings/:section')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  updateSection(
    @Param('section') section: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() caller: Caller,
  ) {
    return this.organizationSettingsService.updateSection(
      caller.organizationId,
      section,
      body,
      caller.id,
    );
  }

  @Post('settings/complete-setup')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  completeSetup(@CurrentUser() caller: Caller) {
    return this.organizationSettingsService.completeSetup(
      caller.organizationId,
      caller.id,
    );
  }

  @Post('settings/reset-setup')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  resetSetup(@CurrentUser() caller: Caller) {
    return this.organizationSettingsService.resetSetup(
      caller.organizationId,
      caller.id,
    );
  }

  @Get('settings/document-numbering/:type/preview')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  previewDocumentNumber(
    @Param('type') type: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.organizationSettingsService.previewDocumentNumber(
      caller.organizationId,
      type,
    );
  }
}
