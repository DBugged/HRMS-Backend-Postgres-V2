// Purpose: ESIC monthly contribution upload sheet and Professional Tax return working papers for a month.
// Important: ADMIN/HR only, export-audited and throttled. The ESIC sheet is refused while members have blocking
//   problems (e.g. no ESIC number) unless the caller explicitly leaves them out.
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role, User } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ExportAuditInterceptor } from '../common/sensitive-audit';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { sendReportBranded } from './report-branding';
import type { ReportFormat } from './report-export';
import { StatutoryReturnsService } from './statutory-returns.service';

type Caller = Omit<User, 'password'>;

export class ReturnQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  skipInvalid?: boolean;

  @IsOptional()
  @IsIn(['xlsx', 'csv', 'pdf'])
  format?: ReportFormat;
}

@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('reports/payroll')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
@Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
export class StatutoryReturnsController {
  constructor(
    private readonly service: StatutoryReturnsService,
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  @Get('esic-return/preview')
  esicPreview(@Query() q: ReturnQueryDto, @CurrentUser() c: Caller) {
    return this.service.esic(q.month, q.year, c.organizationId);
  }

  @Get('esic-return')
  @UseInterceptors(ExportAuditInterceptor)
  async esicDownload(
    @Query() q: ReturnQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    const r = await this.service.esic(q.month, q.year, c.organizationId);
    if (r.members === 0) {
      throw new BadRequestException(
        'No ESIC-covered members found in locked payroll for this month — nothing to upload.',
      );
    }
    if (r.errors.length > 0 && !q.skipInvalid) {
      throw new BadRequestException(
        `The ESIC sheet cannot be uploaded as is: ${r.errors
          .slice(0, 5)
          .map((e) => `${e.name} — ${e.message}`)
          .join(
            ' | ',
          )}${r.errors.length > 5 ? ` (+${r.errors.length - 5} more)` : ''}`,
      );
    }
    if (r.rows.length === 0) {
      throw new BadRequestException(
        'Every ESIC member has a blocking problem, so there is nothing to upload — see the check for details.',
      );
    }
    const wb = this.service.esicWorkbook(r.rows);
    const csv = q.format === 'csv';
    const buf = csv ? await wb.csv.writeBuffer() : await wb.xlsx.writeBuffer();
    res.set({
      'Content-Type': csv
        ? 'text/csv; charset=utf-8'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${r.fileBase}.${csv ? 'csv' : 'xlsx'}"`,
      'X-ESIC-Members': String(r.rows.length),
      'X-ESIC-Skipped': String(r.errors.length),
    });
    res.end(Buffer.from(buf));
  }

  @Get('pt-return/preview')
  ptPreview(@Query() q: ReturnQueryDto, @CurrentUser() c: Caller) {
    return this.service
      .pt(q.month, q.year, c.organizationId)
      .then(({ members, ...rest }) => ({
        ...rest,
        employees: members.length,
      }));
  }

  @Get('pt-return')
  @UseInterceptors(ExportAuditInterceptor)
  async ptMembers(
    @Query() q: ReturnQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    const report = await this.service.ptMemberReport(
      q.month,
      q.year,
      c.organizationId,
    );
    await sendReportBranded(res, this.scopedPrisma, c.organizationId, {
      ...report,
      format: q.format ?? 'xlsx',
    });
  }

  @Get('pt-return/summary')
  @UseInterceptors(ExportAuditInterceptor)
  async ptSummary(
    @Query() q: ReturnQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    const report = await this.service.ptSummaryReport(
      q.month,
      q.year,
      c.organizationId,
    );
    await sendReportBranded(res, this.scopedPrisma, c.organizationId, {
      ...report,
      format: q.format ?? 'xlsx',
    });
  }

  @Get('lwf-return/preview')
  lwfPreview(@Query() q: ReturnQueryDto, @CurrentUser() c: Caller) {
    return this.service
      .lwf(q.month, q.year, c.organizationId)
      .then(({ members, ...rest }) => ({
        ...rest,
        employees: members.length,
      }));
  }

  @Get('lwf-return')
  @UseInterceptors(ExportAuditInterceptor)
  async lwfDownload(
    @Query() q: ReturnQueryDto,
    @CurrentUser() c: Caller,
    @Res() res: Response,
  ) {
    const report = await this.service.lwfReport(
      q.month,
      q.year,
      c.organizationId,
    );
    await sendReportBranded(res, this.scopedPrisma, c.organizationId, {
      ...report,
      format: q.format ?? 'xlsx',
    });
  }
}
