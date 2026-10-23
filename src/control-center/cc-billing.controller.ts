// Purpose: /api/v1/billing, /payments, /coupons and /feature-flags for the Control Panel. Guards as in cc-customers.controller.ts.
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CcAuthGuard } from './cc-auth.guard';
import { CcPermission, CcPermissionGuard } from './cc-permission.guard';
import { CcBillingService } from './cc-billing.service';
import type { PageQuery } from './cc-util';

type Body_ = Record<string, unknown>;

@ApiTags('control-center')
@Public()
@UseGuards(CcAuthGuard, CcPermissionGuard)
@Controller('api/v1')
export class CcBillingController {
  constructor(private readonly svc: CcBillingService) {}

  @Get('billing/invoices') @CcPermission('billing:read') invoices(@Query() q: PageQuery & { status?: string; organizationId?: string }) { return this.svc.listInvoices(q); }
  @Get('billing/invoices/:id') @CcPermission('billing:read') invoice(@Param('id') id: string) { return this.svc.getInvoice(id); }
  @Get('billing/invoices/:id/pdf') @CcPermission('billing:read')
  async invoicePdf(@Param('id') id: string, @Res() res: Response) {
    const pdf = await this.svc.invoicePdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${id.slice(0, 8)}.pdf"`);
    res.send(pdf);
  }
  @Post('billing/invoices') @CcPermission('billing:write') createInvoice(@Body() b: Parameters<CcBillingService['createInvoice']>[0]) { return this.svc.createInvoice(b); }
  @Post('billing/invoices/generate') @HttpCode(200) @CcPermission('billing:write') generate(@Body() b: { organizationId: string }) { return this.svc.generateInvoice(b.organizationId); }
  @Post('billing/invoices/:id/send') @HttpCode(200) @CcPermission('billing:write') send(@Param('id') id: string, @Body() b: { to?: string }) { return this.svc.sendInvoice(id, b?.to); }
  @Post('billing/invoices/:id/void') @HttpCode(200) @CcPermission('billing:write') voidInvoice(@Param('id') id: string) { return this.svc.voidInvoice(id); }
  @Post('billing/invoices/:id/mark-paid') @HttpCode(200) @CcPermission('billing:write') markPaid(@Param('id') id: string, @Body() b: { paymentRef?: string }) { return this.svc.markPaid(id, b?.paymentRef ?? ''); }

  @Get('payments') @CcPermission('payments:read') payments(@Query() q: PageQuery & { status?: string; organizationId?: string; invoiceId?: string }) { return this.svc.listPayments(q); }
  @Get('payments/:id') @CcPermission('payments:read') payment(@Param('id') id: string) { return this.svc.getPayment(id); }
  @Post('payments') @CcPermission('payments:write') createPayment(@Body() b: Parameters<CcBillingService['createPayment']>[0]) { return this.svc.createPayment(b); }
  @Post('payments/:id/refund') @HttpCode(200) @CcPermission('payments:write') refund(@Param('id') id: string, @Body() b: { amount: number; reason: string }) { return this.svc.refund(id, b); }

  @Get('coupons') @CcPermission('coupons:read') coupons(@Query() q: PageQuery & { status?: string }) { return this.svc.listCoupons(q); }
  @Post('coupons/validate') @HttpCode(200) @CcPermission('coupons:read') validate(@Body() b: { code: string; organizationId: string; planId: string }) { return this.svc.validateCoupon(b); }
  @Get('coupons/:id') @CcPermission('coupons:read') coupon(@Param('id') id: string) { return this.svc.getCoupon(id); }
  @Post('coupons') @CcPermission('coupons:write') createCoupon(@Body() b: Body_) { return this.svc.createCoupon(b); }
  @Patch('coupons/:id') @CcPermission('coupons:write') updateCoupon(@Param('id') id: string, @Body() b: Body_) { return this.svc.updateCoupon(id, b); }
  @Delete('coupons/:id') @HttpCode(204) @CcPermission('coupons:write') async removeCoupon(@Param('id') id: string) { await this.svc.removeCoupon(id); }

  @Get('feature-flags') @CcPermission('feature-flags:read') flags(@Query() q: PageQuery) { return this.svc.listFlags(q); }
  @Post('feature-flags') @CcPermission('feature-flags:write') createFlag(@Body() b: { key: string; description?: string; defaultValue?: unknown }) { return this.svc.createFlag(b); }
  @Patch('feature-flags/:key') @CcPermission('feature-flags:write') updateFlag(@Param('key') key: string, @Body() b: { description?: string; defaultValue?: unknown; status?: string }) { return this.svc.updateFlag(key, b); }
  @Get('feature-flags/:key/overrides') @CcPermission('feature-flags:read') overrides(@Param('key') key: string) { return this.svc.listOverrides(key); }
  @Put('feature-flags/:key/overrides/:orgId') @CcPermission('feature-flags:write') setOverride(@Param('key') key: string, @Param('orgId') orgId: string, @Body() b: { value: unknown }) { return this.svc.setOverride(key, orgId, b?.value); }
  @Delete('feature-flags/:key/overrides/:orgId') @HttpCode(204) @CcPermission('feature-flags:write') async removeOverride(@Param('key') key: string, @Param('orgId') orgId: string) { await this.svc.removeOverride(key, orgId); }
}
