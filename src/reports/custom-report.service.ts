// Purpose: Generic ad-hoc report builder — pick a data source, pick columns, get rows — driving the
// frontend's custom report screen.
// Responsibilities: Owns column/source validation and MANAGER-role scoping (forced to their own department,
// blocked from restricted sources); delegates actual data fetching per source to CUSTOM_REPORT_SOURCES'
// fetch functions.
// Important: MANAGER_BLOCKED_SOURCES exists so this generic builder can't become a side door around the
// ADMIN/HR-only restriction the dedicated /reports/payroll route already enforces; a MANAGER with no
// department assigned is denied outright rather than silently falling through to an unfiltered (org-wide) view.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { CUSTOM_REPORT_SOURCES } from './custom-report-sources';
import { CustomReportQueryDto } from './dto/custom-report-query.dto';
import { ReportColumn } from './report-export';

type Actor = Omit<User, 'password'>;

// Sources a MANAGER may never run — matches the ADMIN/HR-only restriction
// the dedicated /reports/payroll route already enforces; the generic
// report builder must not become a side door around it.
const MANAGER_BLOCKED_SOURCES = new Set(['payroll']);

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

  async run(query: CustomReportQueryDto, actor: Actor, organizationId: string) {
    const src = CUSTOM_REPORT_SOURCES[query.source];
    if (!src) {
      throw new BadRequestException(
        `source must be one of: ${Object.keys(CUSTOM_REPORT_SOURCES).join(', ')}.`,
      );
    }
    if (actor.role === Role.MANAGER) {
      if (MANAGER_BLOCKED_SOURCES.has(query.source)) {
        throw new ForbiddenException(
          `The "${query.source}" report source is restricted to Admin/HR.`,
        );
      }
      // A MANAGER with no department assigned has no valid dept-scoped
      // view — deny rather than let the department filter below silently
      // fall through to "unfiltered" (org-wide).
      if (!actor.departmentId) {
        throw new ForbiddenException(
          'You must be assigned to a department to run this report.',
        );
      }
    }
    const requestedColumns = (
      query.columns ? query.columns.split(',') : Object.keys(src.columns)
    ).filter((c) => src.columns[c]);
    if (requestedColumns.length === 0) {
      throw new BadRequestException('At least one valid column is required.');
    }

    const records = await src.fetch(
      {
        department:
          // MANAGER never gets to choose a department filter — always
          // forced to their own, so they can't run this report for a
          // department they don't manage.
          actor.role === Role.MANAGER
            ? (actor.departmentId ?? undefined)
            : query.department,
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
