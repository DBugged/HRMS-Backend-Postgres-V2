// Purpose: /api/v1/reports/* (revenue, ageing, GST) and CSV exports for the Control Panel.
import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { CcAuthGuard } from './cc-auth.guard';
import { CcPermission, CcPermissionGuard } from './cc-permission.guard';
import { CcReportsService } from './cc-reports.service';

@ApiTags('control-center')
@Public()
@UseGuards(CcAuthGuard, CcPermissionGuard)
@Controller('api/v1')
export class CcReportsController {
  constructor(private readonly svc: CcReportsService) {}

  @Get('reports/revenue') @CcPermission('billing:read') revenue(@Query('months') m?: string) { return this.svc.revenue(Number(m) || 12); }
  @Get('reports/ageing') @CcPermission('billing:read') ageing() { return this.svc.ageing(); }
  @Get('reports/gst') @CcPermission('billing:read') gst(@Query('months') m?: string) { return this.svc.gst(Number(m) || 12); }

  @Get('exports/organizations') @CcPermission('organizations:read')
  async orgs(@Res() res: Response) { this.csv(res, 'organizations', await this.svc.exportOrganizations()); }
  @Get('exports/invoices') @CcPermission('billing:read')
  async invoices(@Query('organizationId') id: string | undefined, @Res() res: Response) { this.csv(res, 'invoices', await this.svc.exportInvoices(id)); }

  private csv(res: Response, name: string, body: string) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(body);
  }
}
