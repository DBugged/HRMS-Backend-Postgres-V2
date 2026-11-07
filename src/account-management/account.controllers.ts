// Purpose: the five Company Admin Account Management API areas. Each is Admin-only (RolesGuard) and, because its first path segment
//   is mapped in module-routes.ts, is refused for a company whose Super Admin switched that tab off - even by direct URL.
// Important: the organisation is always the signed-in user's; no organisation id is accepted from the client.
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role, type User } from '@prisma/client';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AccountService } from './account.service';
import { AccountExportService } from './account-export.service';
import { AccountSupportService } from './account-support.service';
import { AccountExportScheduleService } from './account-export-schedule.service';
import { Public } from '../common/decorators/public.decorator';

type Caller = Omit<User, 'password'>;
type Body_ = Record<string, unknown>;

@ApiTags('account-billing')
@ApiBearerAuth('access-token')
@Controller('account-billing')
@Roles(Role.ADMIN)
@UseGuards(RolesGuard)
export class AccountBillingController {
  constructor(private readonly svc: AccountService) {}
  @Get('overview') overview(@CurrentUser() u: Caller) { return this.svc.overview(u.organizationId); }
  @Get('invoices') invoices(@CurrentUser() u: Caller) { return this.svc.invoices(u.organizationId); }
  @Get('invoices/:id/pdf')
  async invoicePdf(@CurrentUser() u: Caller, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { buffer, filename } = await this.svc.invoicePdf(u.organizationId, id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }
  @Get('payments') payments(@CurrentUser() u: Caller) { return this.svc.payments(u.organizationId); }
  @Get('details') details(@CurrentUser() u: Caller) { return this.svc.billingDetails(u.organizationId); }
  @Get('requests') requests(@CurrentUser() u: Caller) { return this.svc.listRequests(u.organizationId, ['RENEWAL', 'CANCELLATION']); }
  @Post('requests') request(@CurrentUser() u: Caller, @Body() b: { type: string; message?: string; payload?: Body_ }) {
    return this.svc.createRequest(u, ['RENEWAL', 'CANCELLATION'], { type: b?.type, message: b?.message, payload: b?.payload });
  }
  @Post('requests/:id/withdraw') withdraw(@CurrentUser() u: Caller, @Param('id', ParseUUIDPipe) id: string) { return this.svc.withdrawRequest(u, id, ['RENEWAL', 'CANCELLATION']); }
}

@ApiTags('account-plan')
@ApiBearerAuth('access-token')
@Controller('account-plan')
@Roles(Role.ADMIN)
@UseGuards(RolesGuard)
export class AccountPlanController {
  constructor(private readonly svc: AccountService) {}
  @Get('overview') async overview(@CurrentUser() u: Caller) {
    const [o, plans] = await Promise.all([this.svc.overview(u.organizationId), this.svc.availablePlans(u.organizationId)]);
    return { subscription: o.subscription, plans };
  }
  @Get('modules') modules(@CurrentUser() u: Caller) { return this.svc.modules(u.organizationId); }
  @Get('requests') requests(@CurrentUser() u: Caller) { return this.svc.listRequests(u.organizationId, ['PLAN_UPGRADE', 'EXTRA_LICENCES', 'ADD_ON', 'MODULE_UPGRADE']); }
  @Post('requests') request(@CurrentUser() u: Caller, @Body() b: { type: string; message?: string; payload?: Body_ }) {
    return this.svc.createRequest(u, ['PLAN_UPGRADE', 'EXTRA_LICENCES', 'ADD_ON', 'MODULE_UPGRADE'], b ?? { type: '' });
  }
  @Post('requests/:id/withdraw') withdraw(@CurrentUser() u: Caller, @Param('id', ParseUUIDPipe) id: string) { return this.svc.withdrawRequest(u, id, ['PLAN_UPGRADE', 'EXTRA_LICENCES', 'ADD_ON', 'MODULE_UPGRADE']); }
}

@ApiTags('account-usage')
@ApiBearerAuth('access-token')
@Controller('account-usage')
@Roles(Role.ADMIN)
@UseGuards(RolesGuard)
export class AccountUsageController {
  constructor(private readonly svc: AccountService) {}
  @Get() usage(@CurrentUser() u: Caller) { return this.svc.usage(u.organizationId); }
  @Get('trend') trend(@CurrentUser() u: Caller) { return this.svc.usageTrend(u.organizationId); }
}

@ApiTags('account-export')
@ApiBearerAuth('access-token')
@Controller('account-export')
@Roles(Role.ADMIN)
@UseGuards(RolesGuard)
export class AccountExportController {
  constructor(private readonly svc: AccountExportService, private readonly schedules: AccountExportScheduleService) {}
  @Get('schedules') listSchedules(@CurrentUser() u: Caller) { return this.schedules.list(u.organizationId); }
  @Get('schedules/recipients') recipients(@CurrentUser() u: Caller) { return this.schedules.allowedRecipients(u.organizationId); }
  @Post('schedules') saveSchedule(@CurrentUser() u: Caller, @Body() b: { category?: string; categories?: string[]; dayOfMonth?: number; recipients?: string[]; extraEmails?: string[]; enabled?: boolean; format?: string }) { return this.schedules.save(u, b ?? {}); }
  @Delete('schedules/:id') removeSchedule(@CurrentUser() u: Caller, @Param('id', ParseUUIDPipe) id: string) { return this.schedules.remove(u, id); }
  @Post('schedules/:id/run') @Throttle({ default: { limit: 5, ttl: 60_000 } }) runSchedule(@CurrentUser() u: Caller, @Param('id', ParseUUIDPipe) id: string) { return this.schedules.runNow(u.organizationId, id); }
  @Get('categories') categories() { return this.svc.categories(); }
  @Get('history') history(@CurrentUser() u: Caller) { return this.svc.history(u.organizationId); }
  @Post() @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@CurrentUser() u: Caller, @Body() b: { category: string; format?: string; from?: string; to?: string }) { return this.svc.create(u, b ?? { category: '' }); }
  @Get(':id/download')
  async download(@CurrentUser() u: Caller, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const f = await this.svc.download(u, id);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`);
    res.send(f.buffer);
  }
}

@ApiTags('account-support')
@ApiBearerAuth('access-token')
@Controller('account-support')
@Roles(Role.ADMIN)
@UseGuards(RolesGuard)
export class AccountSupportController {
  constructor(private readonly svc: AccountSupportService) {}
  @Get('tickets') list(@CurrentUser() u: Caller, @Query() _q: Body_) { return this.svc.list(u.organizationId); }
  @Get('tickets/:id') get(@CurrentUser() u: Caller, @Param('id', ParseUUIDPipe) id: string) { return this.svc.get(u.organizationId, id); }
  @Post('tickets') create(@CurrentUser() u: Caller, @Body() b: Body_) { return this.svc.create(u, b ?? {}); }
  @Post('tickets/:id/replies') reply(@CurrentUser() u: Caller, @Param('id', ParseUUIDPipe) id: string, @Body() b: Body_) { return this.svc.reply(u, id, b ?? {}); }
  @Post('tickets/:id/close') close(@CurrentUser() u: Caller, @Param('id', ParseUUIDPipe) id: string) { return this.svc.setClosed(u, id, true); }
  @Post('tickets/:id/reopen') reopen(@CurrentUser() u: Caller, @Param('id', ParseUUIDPipe) id: string) { return this.svc.setClosed(u, id, false); }
}

@ApiTags('account-activity')
@ApiBearerAuth('access-token')
@Controller('account-activity')
@Roles(Role.ADMIN)
@UseGuards(RolesGuard)
export class AccountActivityController {
  constructor(private readonly svc: AccountService) {}
  @Get() activity(@CurrentUser() u: Caller) { return this.svc.activity(u.organizationId); }
}

// The page a person lands on from the confirmation email. Public by necessity (they are not signed in); it exposes nothing but "confirmed" or "invalid".
@ApiTags('account-export')
@Controller('public/account-export')
export class AccountExportConfirmController {
  constructor(private readonly schedules: AccountExportScheduleService) {}
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('confirm')
  async confirm(@Query('token') token: string, @Res() res: Response) {
    const result = await this.schedules.confirmRecipient(String(token ?? ''));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    const ok = result === 'OK';
    res.status(ok ? 200 : 400).send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? 'Confirmed' : 'Link not valid'}</title><body style="font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;text-align:center"><h2>${ok ? 'Thank you, you are confirmed.' : 'This link is not valid.'}</h2><p>${ok ? 'You will receive the monthly data export by email.' : 'It may have expired or already been used. Ask the person who set it up to save the schedule again.'}</p></body>`);
  }
}
