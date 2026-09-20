import { BadRequestException } from '@nestjs/common';

/**
 * Safety cap for report/export queries so a whole-org, whole-history request
 * can't load an unbounded result set into memory. Queries fetch LIMIT + 1 rows
 * and `assertWithinReportLimit` rejects when the extra row shows up.
 */
export const REPORT_ROW_LIMIT = 50000;

export function assertWithinReportLimit(rows: readonly unknown[]): void {
  if (rows.length > REPORT_ROW_LIMIT) {
    throw new BadRequestException(
      `This report exceeds ${REPORT_ROW_LIMIT} rows. Narrow the filters (e.g. a smaller date range) and try again.`,
    );
  }
}
