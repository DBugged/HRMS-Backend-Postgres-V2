// Purpose: Exposes CRUD + bulk import for org-scoped named lists (Designations, Grades / Levels,
//   Employee Categories).
// Responsibilities: Validates DTOs and delegates to OrgListItemsService.
// Important: findAll has no @Roles() — any authenticated caller needs it for Employee form dropdowns,
//   same convention as DepartmentsController; writes are ADMIN/HR.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { OrgListType, Role, User } from '@prisma/client';
import { OrgListItemsService } from './org-list-items.service';
import { CreateOrgListItemDto } from './dto/create-org-list-item.dto';
import { UpdateOrgListItemDto } from './dto/update-org-list-item.dto';
import { BulkImportOrgListItemsDto } from './dto/bulk-import-org-list-items.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('org-list-items')
@ApiBearerAuth('access-token')
@Controller('org-list-items')
export class OrgListItemsController {
  constructor(private readonly orgListItemsService: OrgListItemsService) {}

  @Get()
  findAll(@Query('type') type: OrgListType, @CurrentUser() caller: Caller) {
    return this.orgListItemsService.findAll(type, caller.organizationId);
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateOrgListItemDto, @CurrentUser() caller: Caller) {
    return this.orgListItemsService.create(dto, caller.organizationId, caller);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOrgListItemDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.orgListItemsService.update(
      id,
      dto.name,
      caller.organizationId,
      caller,
    );
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.orgListItemsService.delete(id, caller.organizationId, caller);
  }

  @Post('bulk-import')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  bulkImport(
    @Body() dto: BulkImportOrgListItemsDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.orgListItemsService.bulkImport(
      dto,
      caller.organizationId,
      caller,
    );
  }
}
