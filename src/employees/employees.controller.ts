// Purpose: Exposes employee CRUD plus profile sub-resources — documents, assets, probation, role/status history.
// Responsibilities: Validates DTOs and delegates to EmployeesService (core record) or EmployeeProfileService (sub-resources).
// Important: Roles vary per route (ADMIN/HR, self-or-ADMIN/HR/MANAGER); document/asset read routes have no @Roles() and self-scope in the service.
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
import { EmployeeDocumentCategory, Role, User } from '@prisma/client';
import { EmployeesService } from './employees.service';
import { EmployeeProfileService } from './employee-profile.service';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { BulkCreateEmployeesDto } from './dto/bulk-create-employees.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import { ListEmployeesQueryDto } from './dto/list-employees-query.dto';
import { UpdatePersonalDataDto } from './dto/update-personal-data.dto';
import { ProbationDecisionDto } from './dto/probation-decision.dto';
import { CreateEmployeeDocumentDto } from './dto/create-employee-document.dto';
import { ReviewEmployeeDocumentDto } from './dto/review-employee-document.dto';
import { CreateEmployeeAssetDto } from './dto/create-employee-asset.dto';
import { UpdateEmployeeAssetDto } from './dto/update-employee-asset.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { SelfOrRoles } from '../common/decorators/self-or-roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('employees')
@ApiBearerAuth('access-token')
@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly employeeProfileService: EmployeeProfileService,
  ) {}

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateEmployeeDto, @CurrentUser() caller: Caller) {
    return this.employeesService.create(dto, caller, caller.organizationId);
  }

  @Post('bulk')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  bulkCreate(
    @Body() dto: BulkCreateEmployeesDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeesService.bulkCreate(
      dto.rows,
      caller,
      caller.organizationId,
    );
  }

  @Get()
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  findAll(
    @Query() query: ListEmployeesQueryDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeesService.findAll(query, caller, caller.organizationId);
  }

  // Org-wide variants — must come before the :id routes below, or Nest
  // would match "assets"/"role-history" as an :id value instead.
  @Get('assets')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  listAllAssets(@CurrentUser() caller: Caller) {
    return this.employeeProfileService.listAllAssets(caller.organizationId);
  }

  @Get('role-history')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  listAllRoleHistory(@CurrentUser() caller: Caller) {
    return this.employeeProfileService.listAllRoleHistory(
      caller.organizationId,
    );
  }

  @Get(':id')
  @SelfOrRoles('id', Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  findOne(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.employeesService.findOne(id, caller, caller.organizationId);
  }

  @Patch(':id')
  @SelfOrRoles('id', Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateEmployeeDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeesService.update(id, dto, caller, caller.organizationId);
  }

  @Patch(':id/deactivate')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  deactivate(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.employeesService.deactivate(id, caller, caller.organizationId);
  }

  @Post(':id/resend-credentials')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  resendCredentials(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.employeesService.resendCredentials(id, caller.organizationId);
  }

  @Patch(':id/personal-data')
  updatePersonalData(
    @Param('id') id: string,
    @Body() dto: UpdatePersonalDataDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeProfileService.updatePersonalData(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Get(':id/full-profile')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  getFullProfile(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.employeeProfileService.getFullProfile(
      id,
      caller,
      caller.organizationId,
    );
  }

  @Get(':id/role-history')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  getRoleHistory(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.employeeProfileService.getRoleHistory(
      id,
      caller.organizationId,
    );
  }

  @Get(':id/employment-status-history')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  getEmploymentStatusHistory(
    @Param('id') id: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeProfileService.getEmploymentStatusHistory(
      id,
      caller.organizationId,
    );
  }

  @Patch(':id/probation-decision')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  probationDecision(
    @Param('id') id: string,
    @Body() dto: ProbationDecisionDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeProfileService.probationDecision(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Get(':id/documents')
  listDocuments(
    @Param('id') id: string,
    @Query('category') category: EmployeeDocumentCategory | undefined,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeProfileService.listDocuments(
      id,
      caller,
      caller.organizationId,
      category,
    );
  }

  @Post(':id/documents')
  addDocument(
    @Param('id') id: string,
    @Body() dto: CreateEmployeeDocumentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeProfileService.addDocument(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Delete(':id/documents/:docId')
  removeDocument(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeProfileService.removeDocument(
      id,
      docId,
      caller,
      caller.organizationId,
    );
  }

  @Patch(':id/documents/:docId/review')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  reviewDocument(
    @Param('id') id: string,
    @Param('docId') docId: string,
    @Body() dto: ReviewEmployeeDocumentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeProfileService.reviewDocument(
      id,
      docId,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Get(':id/assets')
  listAssets(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.employeeProfileService.listAssets(
      id,
      caller,
      caller.organizationId,
    );
  }

  @Post(':id/assets')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  allocateAsset(
    @Param('id') id: string,
    @Body() dto: CreateEmployeeAssetDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeProfileService.allocateAsset(
      id,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Patch(':id/assets/:assetId')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updateAssetStatus(
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @Body() dto: UpdateEmployeeAssetDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeProfileService.updateAssetStatus(
      id,
      assetId,
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Delete(':id/assets/:assetId')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  removeAsset(
    @Param('id') id: string,
    @Param('assetId') assetId: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.employeeProfileService.removeAsset(
      id,
      assetId,
      caller,
      caller.organizationId,
    );
  }
}
