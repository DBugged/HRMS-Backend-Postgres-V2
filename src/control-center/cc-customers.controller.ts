// Purpose: Dashboard and organization endpoints for the Control Panel (read-only for now), at /api/v1/*.
// Important: @Public() only switches off the HRMS token guard; CcAuthGuard + CcPermissionGuard protect every route here.
import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import type { SuperAdmin } from '@prisma/client';
import { CcAuthGuard, CurrentSuperAdmin } from './cc-auth.guard';
import { CcPermission, CcPermissionGuard } from './cc-permission.guard';
import { CcCustomersService } from './cc-customers.service';

@ApiTags('control-center')
@Public()
@UseGuards(CcAuthGuard, CcPermissionGuard)
@Controller('api/v1')
export class CcCustomersController {
  constructor(private readonly customers: CcCustomersService) {}

  @Get('usage/overview')
  @CcPermission('usage:read')
  overview() {
    return this.customers.overview();
  }

  @Get('usage/organizations/:id')
  @CcPermission('usage:read')
  orgUsageAlias(@Param('id') id: string) {
    return this.customers.orgUsage(id);
  }

  @Get('organizations')
  @CcPermission('organizations:read')
  list(@Query() q: { page?: string; pageSize?: string; q?: string; sort?: string; status?: string }) {
    return this.customers.list({ ...q, page: q.page ? Number(q.page) : undefined, pageSize: q.pageSize ? Number(q.pageSize) : undefined });
  }

  @Post('organizations')
  @CcPermission('organizations:write')
  create(@Body() b: { name: string; adminName: string; adminEmail: string; planId?: string }) {
    return this.customers.create(b);
  }

  @Patch('organizations/:id')
  @CcPermission('organizations:write')
  update(@Param('id') id: string, @Body() b: Record<string, string>) {
    return this.customers.update(id, b);
  }

  @Get('organizations/:id/feature-flags')
  @CcPermission('feature-flags:read')
  orgFlags(@Param('id') id: string) {
    return this.customers.orgFlags(id);
  }

  @Post('organizations/:id/admins/:userId/reset-password')
  @HttpCode(200)
  @CcPermission('organizations:write')
  resetAdmin(@Param('id') id: string, @Param('userId') userId: string, @CurrentSuperAdmin() a: SuperAdmin) {
    return this.customers.sendAdminReset(id, userId, a.email);
  }

  @Get('organizations/:id')
  @CcPermission('organizations:read')
  get(@Param('id') id: string) {
    return this.customers.get(id);
  }

  @Get('organizations/:id/usage')
  @CcPermission('usage:read')
  orgUsage(@Param('id') id: string) {
    return this.customers.orgUsage(id);
  }

  @Get('organizations/:id/admins')
  @CcPermission('organizations:read')
  admins(@Param('id') id: string) {
    return this.customers.admins(id);
  }

  @Post('organizations/:id/suspend')
  @HttpCode(200)
  @CcPermission('organizations:write')
  suspend(@Param('id') id: string, @Body() b: { reason?: string }, @CurrentSuperAdmin() a: SuperAdmin) {
    return this.customers.setStatus(id, 'SUSPENDED', a.email, b?.reason);
  }

  @Post('organizations/:id/reactivate')
  @HttpCode(200)
  @CcPermission('organizations:write')
  reactivate(@Param('id') id: string, @CurrentSuperAdmin() a: SuperAdmin) {
    return this.customers.setStatus(id, 'ACTIVE', a.email);
  }

  @Post('organizations/:id/archive')
  @HttpCode(200)
  @CcPermission('organizations:write')
  archive(@Param('id') id: string, @Body() b: { reason?: string }, @CurrentSuperAdmin() a: SuperAdmin) {
    return this.customers.setStatus(id, 'ARCHIVED', a.email, b?.reason);
  }

  @Post('organizations/bulk-archive')
  @HttpCode(200)
  @CcPermission('organizations:write')
  bulkArchive(@Body() b: { ids?: string[]; reason?: string }, @CurrentSuperAdmin() a: SuperAdmin) {
    return this.customers.bulk('archive', b?.ids ?? [], a.email, b?.reason);
  }

  /** The panel makes the user type DELETE; the server insists on it too. */
  @Post('organizations/bulk-delete')
  @HttpCode(200)
  @CcPermission('organizations:write')
  bulkDelete(@Body() b: { ids?: string[]; confirm?: string }, @CurrentSuperAdmin() a: SuperAdmin) {
    if (a.role !== 'OWNER') throw new ForbiddenException('Only an Owner can permanently delete organizations.');
    if (b?.confirm !== 'DELETE') throw new BadRequestException('Type DELETE to confirm.');
    return this.customers.bulk('delete', b?.ids ?? [], a.email);
  }

  /** Permanent and irreversible, so it is limited to the Owner role and needs the organization's name typed in. */
  @Delete('organizations/:id')
  @CcPermission('organizations:write')
  remove(@Param('id') id: string, @Body() b: { confirmName?: string }, @CurrentSuperAdmin() a: SuperAdmin) {
    if (a.role !== 'OWNER') throw new ForbiddenException('Only an Owner can permanently delete an organization.');
    return this.customers.remove(id, b?.confirmName ?? '', a.email);
  }

}
