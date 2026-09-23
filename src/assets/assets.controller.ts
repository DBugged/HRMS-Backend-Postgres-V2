// Purpose: Exposes the Asset Inventory master (/assets) and its warranty/maintenance/document/history
//   sub-resources.
// Responsibilities: Validates DTOs, applies the module's role rules, and delegates to AssetsService.
// Important: ADMIN/HR only throughout — MANAGER and EMPLOYEE have no access to this module at all.
//   Two actions are further narrowed to ADMIN: soft delete, and a status change to RETIRED/DISPOSED
//   (which can't be a @Roles() difference since it depends on the request body, so it's enforced in
//   the handler below). There is no assign/return/transfer route here by design — assignment lives in
//   the Employees module.
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
// Retiring or disposing of an asset writes off company property — Admin
// only (shared with the service so create() applies the same gate).
import { ADMIN_ONLY_STATUSES, AssetsService } from './assets.service';
import { CreateAssetDto } from './dto/create-asset.dto';
import { BulkImportAssetsDto } from './dto/bulk-import-assets.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { UpdateAssetStatusDto } from './dto/update-asset-status.dto';
import { UpdateAssetWarrantyDto } from './dto/update-asset-warranty.dto';
import { CreateAssetMaintenanceDto } from './dto/create-asset-maintenance.dto';
import { UpdateAssetMaintenanceDto } from './dto/update-asset-maintenance.dto';
import { CreateAssetDocumentDto } from './dto/create-asset-document.dto';
import { ListAssetsQueryDto } from './dto/list-assets-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('assets')
@ApiBearerAuth('access-token')
@Controller('assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Get()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  findAll(@Query() query: ListAssetsQueryDto, @CurrentUser() caller: Caller) {
    return this.assetsService.findAll(query, caller.organizationId);
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateAssetDto, @CurrentUser() caller: Caller) {
    return this.assetsService.create(dto, caller.organizationId, caller);
  }

  @Post('bulk-import')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  bulkImport(@Body() dto: BulkImportAssetsDto, @CurrentUser() caller: Caller) {
    return this.assetsService.bulkImport(dto, caller.organizationId, caller);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  findOne(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.assetsService.findOne(id, caller.organizationId);
  }

  @Get(':id/history')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  history(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.assetsService.history(id, caller.organizationId);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAssetDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.assetsService.update(id, dto, caller.organizationId, caller);
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateAssetStatusDto,
    @CurrentUser() caller: Caller,
  ) {
    if (
      ADMIN_ONLY_STATUSES.includes(dto.status) &&
      caller.role !== Role.ADMIN
    ) {
      throw new ForbiddenException(
        'Only an administrator can retire or dispose of an asset.',
      );
    }
    return this.assetsService.updateStatus(
      id,
      dto,
      caller.organizationId,
      caller,
    );
  }

  @Patch(':id/warranty')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updateWarranty(
    @Param('id') id: string,
    @Body() dto: UpdateAssetWarrantyDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.assetsService.updateWarranty(
      id,
      dto,
      caller.organizationId,
      caller,
    );
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.assetsService.remove(id, caller.organizationId, caller);
  }

  @Post(':id/maintenance')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  addMaintenance(
    @Param('id') id: string,
    @Body() dto: CreateAssetMaintenanceDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.assetsService.addMaintenance(
      id,
      dto,
      caller.organizationId,
      caller,
    );
  }

  @Patch(':id/maintenance/:maintenanceId')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updateMaintenance(
    @Param('id') id: string,
    @Param('maintenanceId') maintenanceId: string,
    @Body() dto: UpdateAssetMaintenanceDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.assetsService.updateMaintenance(
      id,
      maintenanceId,
      dto,
      caller.organizationId,
      caller,
    );
  }

  @Post(':id/documents')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  addDocument(
    @Param('id') id: string,
    @Body() dto: CreateAssetDocumentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.assetsService.addDocument(
      id,
      dto,
      caller.organizationId,
      caller,
    );
  }

  @Delete(':id/documents/:docId')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  removeDocument(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.assetsService.removeDocument(
      id,
      docId,
      caller.organizationId,
      caller,
    );
  }
}
