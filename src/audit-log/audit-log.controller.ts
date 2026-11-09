// Purpose: Exposes querying the organization's audit log.
// Responsibilities: Validates the query DTO and delegates to AuditLogService.
// Important: Restricted to ADMIN/HR at the controller level. Deleting entries (by date range) is ADMIN-only, needs an
// explicit from/to, and is itself recorded in the trail.
import { Controller, Delete, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { AuditLogService } from './audit-log.service';
import { DeleteAuditLogDto } from './dto/delete-audit-log.dto';
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

  // Re-checks the tamper-evident chain (Admin). HR can read the log but not run the check.
  @Get('verify')
  @Roles(Role.ADMIN)
  verify(@CurrentUser() caller: Caller) {
    return this.auditLogService.verifyChain(caller.organizationId);
  }

  @Get()
  findAll(@Query() query: QueryAuditLogDto, @CurrentUser() caller: Caller) {
    return this.auditLogService.findAll(query, caller, caller.organizationId);
  }

  // Admin-only retention purge of a whole-day date range; the purge is recorded as an AUDIT_LOGS_DELETED entry.
  @Delete()
  @Roles(Role.ADMIN)
  deleteRange(@Query() query: DeleteAuditLogDto, @CurrentUser() caller: Caller) {
    return this.auditLogService.deleteRange(caller, query.from, query.to);
  }
}
