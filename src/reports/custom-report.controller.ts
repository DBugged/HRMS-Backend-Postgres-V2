import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role, User } from '@prisma/client';
import { CustomReportService } from './custom-report.service';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';
import { CustomReportQueryDto } from './dto/custom-report-query.dto';
import { sendReport } from './report-export';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

// Same base gate as the rest of the Reports module (old system mounts
// these two routes on the same router as attendance/leave, with no
// per-route override): [ADMIN, HR, MANAGER].
@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('reports/custom')
@Roles(Role.ADMIN, Role.HR, Role.MANAGER)
@UseGuards(RolesGuard)
@Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
export class CustomReportController {
  constructor(private readonly customReportService: CustomReportService) {}

  @Get('sources')
  getSources() {
    return this.customReportService.listSources();
  }

  @Get()
  async run(
    @Query() query: CustomReportQueryDto,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
  ) {
    const report = await this.customReportService.run(
      query,
      caller.organizationId,
    );
    const format = query.format ?? 'json';
    if (format === 'json') {
      res.json({
        columns: report.columns,
        rows: report.rows,
        total: report.rows.length,
      });
      return;
    }
    await sendReport(res, {
      title: report.title,
      columns: report.exportColumns,
      rows: report.rows,
      filename: report.filename,
      format,
    });
  }
}
