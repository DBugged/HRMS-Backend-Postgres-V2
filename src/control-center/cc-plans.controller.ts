// Purpose: /api/v1/plans and /api/v1/subscriptions for the Control Panel. Guards as in cc-customers.controller.ts.
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { CcAuthGuard } from './cc-auth.guard';
import { CcPermission, CcPermissionGuard } from './cc-permission.guard';
import { CcPlansService } from './cc-plans.service';
import type { PageQuery } from './cc-util';

@ApiTags('control-center')
@Public()
@UseGuards(CcAuthGuard, CcPermissionGuard)
@Controller('api/v1')
export class CcPlansController {
  constructor(private readonly svc: CcPlansService) {}

  @Get('plans') @CcPermission('plans:read') plans(@Query() q: PageQuery) { return this.svc.listPlans(q); }
  @Get('plans/:id') @CcPermission('plans:read') plan(@Param('id') id: string) { return this.svc.getPlan(id); }
  @Post('plans') @CcPermission('plans:write') createPlan(@Body() b: Record<string, unknown>) { return this.svc.createPlan(b); }
  @Patch('plans/:id') @CcPermission('plans:write') updatePlan(@Param('id') id: string, @Body() b: Record<string, unknown>) { return this.svc.updatePlan(id, b); }
  @Delete('plans/:id') @HttpCode(204) @CcPermission('plans:write') async removePlan(@Param('id') id: string) { await this.svc.removePlan(id); }

  @Get('subscriptions') @CcPermission('subscriptions:read')
  subs(@Query() q: PageQuery & { status?: string; organizationId?: string }) { return this.svc.listSubscriptions(q); }
  @Get('subscriptions/:id') @CcPermission('subscriptions:read') sub(@Param('id') id: string) { return this.svc.getSubscription(id); }
  @Post('subscriptions') @CcPermission('subscriptions:write')
  createSub(@Body() b: { organizationId: string; planId: string; trialDaysOverride?: number }) { return this.svc.createSubscription(b); }
  @Post('subscriptions/:id/change-plan') @HttpCode(200) @CcPermission('subscriptions:write')
  change(@Param('id') id: string, @Body() b: { planId: string; prorate?: boolean }) { return this.svc.changePlan(id, b); }
  @Post('subscriptions/:id/cancel') @HttpCode(200) @CcPermission('subscriptions:write')
  cancel(@Param('id') id: string, @Body() b: { atPeriodEnd?: boolean }) { return this.svc.cancel(id, !!b?.atPeriodEnd); }
  @Post('subscriptions/:id/resume') @HttpCode(200) @CcPermission('subscriptions:write') resume(@Param('id') id: string) { return this.svc.resume(id); }
}
