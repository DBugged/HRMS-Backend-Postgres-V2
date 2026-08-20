// Purpose: Exposes a single endpoint for querying the organization's audit log.
// Responsibilities: Validates the query DTO and delegates to AuditLogService.
// Important: Restricted to ADMIN/HR at the controller level, with no per-route override.
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { AuditLogService } from './audit-log.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('audit-log')
@ApiBearerAuth('access-token')
@Controller('audit-logs')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  findAll(@Query() query: QueryAuditLogDto, @CurrentUser() caller: Caller) {
    return this.auditLogService.findAll(query, caller, caller.organizationId);
  }
}
