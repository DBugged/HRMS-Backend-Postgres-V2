// Purpose: the five Company Admin Account Management API areas. Each is Admin-only (RolesGuard) and, because its first path segment
//   is mapped in module-routes.ts, is refused for a company whose Super Admin switched that tab off - even by direct URL.
// Important: the organisation is always the signed-in user's; no organisation id is accepted from the client.
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
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
  @Get('requests') requests(@CurrentUser() u: Caller) { return this.svc.listRequests(u.organizationId, ['RENEWAL', 'CANCELLATION']); }
  @Post('requests') request(@CurrentUser() u: Caller, @Body() b: { type: string; message?: string }) {
    return this.svc.createRequest(u, ['RENEWAL', 'CANCELLATION'], { type: b?.type, message: b?.message });
  }
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
}

@ApiTags('account-usage')
@ApiBearerAuth('access-token')
@Controller('account-usage')
@Roles(Role.ADMIN)
@UseGuards(RolesGuard)
export class AccountUsageController {
  constructor(private readonly svc: AccountService) {}
  @Get() usage(@CurrentUser() u: Caller) { return this.svc.usage(u.organizationId); }
}

@ApiTags('account-export')
@ApiBearerAuth('access-token')
@Controller('account-export')
@Roles(Role.ADMIN)
@UseGuards(RolesGuard)
export class AccountExportController {
  constructor(private readonly svc: AccountExportService) {}
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
