// Purpose: /api/v1 tickets, announcements, audit-log, settings and super-admins for the Control Panel.
import { Body, Controller, ForbiddenException, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { SuperAdmin } from '@prisma/client';
import { Public } from '../common/decorators/public.decorator';
import { CcAuthGuard, CurrentSuperAdmin } from './cc-auth.guard';
import { CcPermission, CcPermissionGuard } from './cc-permission.guard';
import { CcSupportService } from './cc-support.service';
import { CcAutomationService } from './cc-automation.service';
import type { PageQuery } from './cc-util';

type B = Record<string, unknown>;
type Q = PageQuery & Record<string, string | undefined>;

@ApiTags('control-center')
@Public()
@UseGuards(CcAuthGuard, CcPermissionGuard)
@Controller('api/v1')
export class CcSupportController {
  constructor(private readonly svc: CcSupportService, private readonly auto: CcAutomationService) {}

  @Get('alerts') @CcPermission('organizations:read') alerts(@Query() q: Q) { return this.auto.listAlerts(q); }
  @Post('alerts/read-all') @HttpCode(204) @CcPermission('organizations:read') async readAll() { await this.auto.markRead(); }
  @Post('alerts/:id/read') @HttpCode(204) @CcPermission('organizations:read') async readOne(@Param('id') id: string) { await this.auto.markRead(id); }
  /** Runs the daily billing checks now (the same job that runs at 06:30). Owner only: it can create invoices and switch companies off. */
  @Post('automation/run') @HttpCode(200) @CcPermission('settings:write')
  runAutomation(@CurrentSuperAdmin() a: SuperAdmin) {
    if (a.role !== 'OWNER') throw new ForbiddenException('Only an Owner can run the billing automation.');
    return this.auto.run();
  }

  @Get('tickets') @CcPermission('tickets:read') tickets(@Query() q: Q) { return this.svc.listTickets(q); }
  @Get('tickets/:id') @CcPermission('tickets:read') ticket(@Param('id') id: string) { return this.svc.getTicket(id); }
  @Post('tickets') @CcPermission('tickets:write') createTicket(@Body() b: { organizationId?: string; subject: string; body: string; priority?: string }, @CurrentSuperAdmin() a: SuperAdmin) { return this.svc.createTicket(b, a); }
  @Patch('tickets/:id') @CcPermission('tickets:write') updateTicket(@Param('id') id: string, @Body() b: { status?: string; priority?: string; assigneeId?: string | null }) { return this.svc.updateTicket(id, b); }
  @Post('tickets/:id/comments') @CcPermission('tickets:write') comment(@Param('id') id: string, @Body() b: { body: string; internal?: boolean }, @CurrentSuperAdmin() a: SuperAdmin) { return this.svc.addComment(id, b, a); }

  @Get('announcements') @CcPermission('announcements:read') announcements(@Query() q: Q) { return this.svc.listAnnouncements(q); }
  @Get('announcements/:id') @CcPermission('announcements:read') announcement(@Param('id') id: string) { return this.svc.getAnnouncement(id); }
  @Post('announcements') @CcPermission('announcements:write') createAnn(@Body() b: B) { return this.svc.createAnnouncement(b); }
  @Patch('announcements/:id') @CcPermission('announcements:write') updateAnn(@Param('id') id: string, @Body() b: B) { return this.svc.updateAnnouncement(id, b); }
  @Delete('announcements/:id') @HttpCode(204) @CcPermission('announcements:write') async removeAnn(@Param('id') id: string) { await this.svc.removeAnnouncement(id); }
  @Post('announcements/:id/publish') @HttpCode(200) @CcPermission('announcements:write') publish(@Param('id') id: string) { return this.svc.setPublished(id, true); }
  @Post('announcements/:id/email') @HttpCode(200) @CcPermission('announcements:write') emailAnn(@Param('id') id: string) { return this.svc.emailAnnouncement(id); }
  @Post('announcements/:id/unpublish') @HttpCode(200) @CcPermission('announcements:write') unpublish(@Param('id') id: string) { return this.svc.setPublished(id, false); }

  @Get('audit-log') @CcPermission('audit-log:read') audit(@Query() q: Q) { return this.svc.listAudit(q); }
  @Get('audit-log/export') @CcPermission('audit-log:read')
  async exportAudit(@Query() q: Q, @Res() res: Response) {
    const out = await this.svc.exportAudit(q, q.format ?? 'csv');
    res.setHeader('Content-Type', out.type);
    res.setHeader('Content-Disposition', `attachment; filename="audit-log.${out.type === 'text/csv' ? 'csv' : 'json'}"`);
    res.send(out.body);
  }
  @Get('audit-log/:id') @CcPermission('audit-log:read') auditEntry(@Param('id') id: string) { return this.svc.getAudit(id); }

  @Get('settings') @CcPermission('settings:read') settings() { return this.svc.listSettings(); }
  @Get('settings/:key') @CcPermission('settings:read') setting(@Param('key') key: string) { return this.svc.getSetting(key); }
  @Put('settings/:key') @CcPermission('settings:write') setSetting(@Param('key') key: string, @Body() b: { value: unknown }) { return this.svc.updateSetting(key, b?.value); }

  @Get('super-admins') @CcPermission('super-admins:read') admins(@Query() q: Q) { return this.svc.listAdmins(q); }
  @Get('super-admins/:id') @CcPermission('super-admins:read') admin(@Param('id') id: string) { return this.svc.getAdmin(id); }
  @Post('super-admins') @CcPermission('super-admins:write') createAdmin(@Body() b: { email: string; name: string; role: string }, @CurrentSuperAdmin() a: SuperAdmin) { return this.svc.createAdmin(b, a); }
  @Patch('super-admins/:id') @CcPermission('super-admins:write') updateAdmin(@Param('id') id: string, @Body() b: { name?: string; role?: string }, @CurrentSuperAdmin() a: SuperAdmin) { return this.svc.updateAdmin(id, b, a); }
  @Post('super-admins/:id/invite') @HttpCode(200) @CcPermission('super-admins:write') invite(@Param('id') id: string) { return this.svc.inviteAdmin(id); }
  @Post('super-admins/:id/deactivate') @HttpCode(200) @CcPermission('super-admins:write') deactivate(@Param('id') id: string, @CurrentSuperAdmin() a: SuperAdmin) { return this.svc.deactivateAdmin(id, a); }
  @Delete('super-admins/:id') @HttpCode(204) @CcPermission('super-admins:write') async removeAdmin(@Param('id') id: string, @CurrentSuperAdmin() a: SuperAdmin) { await this.svc.removeAdmin(id, a); }
}
