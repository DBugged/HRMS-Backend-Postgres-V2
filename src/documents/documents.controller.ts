// Purpose: Exposes CRUD for policy documents and per-employee document requirements.
// Responsibilities: Validates DTOs and delegates all logic to DocumentsService.
// Important: Read endpoints have no @Roles() and are visibility-filtered in the service; writes are ADMIN/HR only.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { DocumentsService } from './documents.service';
import { CreatePolicyDocumentDto } from './dto/create-policy-document.dto';
import { UpdatePolicyDocumentDto } from './dto/update-policy-document.dto';
import { CreateDocumentRequirementDto } from './dto/create-document-requirement.dto';
import { UpdateDocumentRequirementDto } from './dto/update-document-requirement.dto';
import { BulkDeleteDocumentRequirementsDto } from './dto/bulk-delete-document-requirements.dto';
import { BulkImportDocumentRequirementsDto } from './dto/bulk-import-document-requirements.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('documents')
@ApiBearerAuth('access-token')
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  // No @Roles() — any authenticated caller, visibility-filtered service-side.
  @Get('policies')
  findPolicies(@CurrentUser() caller: Caller) {
    return this.documentsService.findPolicies(caller, caller.organizationId);
  }

  // Old system's hr_admin/administrator collapses to [ADMIN, HR].
  @Post('policies')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  createPolicy(
    @Body() dto: CreatePolicyDocumentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.documentsService.createPolicy(
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Get('policies/:id/versions')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  findPolicyVersions(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.documentsService.findPolicyVersions(id, caller.organizationId);
  }

  @Patch('policies/:id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updatePolicy(
    @Param('id') id: string,
    @Body() dto: UpdatePolicyDocumentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.documentsService.updatePolicy(
      id,
      dto,
      caller.organizationId,
      caller.id,
    );
  }

  @Delete('policies/:id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  deletePolicy(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.documentsService.deletePolicy(
      id,
      caller.organizationId,
      caller.id,
    );
  }

  // No @Roles() — any authenticated caller can see what's expected of them.
  @Get('requirements')
  findRequirements(@CurrentUser() caller: Caller) {
    return this.documentsService.findRequirements(caller.organizationId);
  }

  @Post('requirements')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  createRequirement(
    @Body() dto: CreateDocumentRequirementDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.documentsService.createRequirement(
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Patch('requirements/:id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updateRequirement(
    @Param('id') id: string,
    @Body() dto: UpdateDocumentRequirementDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.documentsService.updateRequirement(
      id,
      dto,
      caller.organizationId,
      caller.id,
    );
  }

  // POST, not DELETE — 'bulk-delete' as a literal path segment would
  // otherwise collide with DELETE requirements/:id (Nest would treat
  // "bulk-delete" as the :id param on the same HTTP method); a request
  // body for the id list also isn't standard on DELETE. Same idiom as
  // ReimbursementsService's bulk-review endpoint.
  @Post('requirements/bulk-delete')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  bulkDeleteRequirements(
    @Body() dto: BulkDeleteDocumentRequirementsDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.documentsService.bulkDeleteRequirements(
      dto,
      caller.organizationId,
      caller.id,
    );
  }

  @Post('requirements/bulk-import')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  bulkImportRequirements(
    @Body() dto: BulkImportDocumentRequirementsDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.documentsService.bulkImportRequirements(
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Delete('requirements/:id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  deleteRequirement(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.documentsService.deleteRequirement(
      id,
      caller.organizationId,
      caller.id,
    );
  }
}
