import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CUSTOM_REPORT_SOURCES } from './custom-report-sources';
import { CustomReportQueryDto } from './dto/custom-report-query.dto';
import { ReportColumn } from './report-export';

@Injectable()
export class CustomReportService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  listSources() {
    return Object.entries(CUSTOM_REPORT_SOURCES).map(([key, s]) => ({
      key,
      label: s.label,
      columns: Object.entries(s.columns).map(([ckey, c]) => ({
        key: ckey,
        label: c.header,
      })),
    }));
  }

  async run(query: CustomReportQueryDto, organizationId: string) {
    const src = CUSTOM_REPORT_SOURCES[query.source];
    if (!src) {
      throw new BadRequestException(
        `source must be one of: ${Object.keys(CUSTOM_REPORT_SOURCES).join(', ')}`,
      );
    }
    const requestedColumns = (
      query.columns ? query.columns.split(',') : Object.keys(src.columns)
    ).filter((c) => src.columns[c]);
    if (requestedColumns.length === 0) {
      throw new BadRequestException('At least one valid column is required.');
    }

    const records = await src.fetch(
      {
        department: query.department,
        from: query.from,
        to: query.to,
        status: query.status,
      },
      organizationId,
      this.scopedPrisma,
    );
    const rows = records.map((record) => {
      const row: Record<string, unknown> = {};
      requestedColumns.forEach((c) => {
        row[c] = src.columns[c].get(record);
      });
      return row;
    });

    const columns: ReportColumn[] = requestedColumns.map((c) => ({
      header: src.columns[c].header,
      key: c,
      width: 20,
    }));

    return {
      title: `Custom Report — ${src.label}`,
      columns: columns.map((c) => ({ key: c.key, label: c.header })),
      exportColumns: columns,
      rows,
      filename: `custom-report-${query.source}`,
    };
  }
}
