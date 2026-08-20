import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { issueDocumentNumber } from '../organizations/document-numbering';

/**
 * Employee ID generation — delegates to the org's own 'employeeId'
 * Document Numbering config (issueDocumentNumber), the same mechanism
 * every other document type uses.
 *
 * Previously this used a separate employeeIdPrefix/employeeIdCounter pair
 * of plain columns on Organization, hardcoded to "EMP-" + 4-digit padding
 * — completely disconnected from the Setup Wizard's Document Numbering
 * step, which only ever fed its own Live Preview. An admin could set a
 * custom format there (e.g. "DP-{00000}") and every real employee would
 * still get "EMP-0001"-shaped IDs. Now the format/prefix/padding/reset
 * rule an admin configures is what actually gets issued.
 */
@Injectable()
export class EmployeeIdService {
  /**
   * Must be called with a transaction client (`tx` from
   * `prisma.$transaction(async (tx) => ...)`), not the plain PrismaService,
   * so the row lock (inside issueDocumentNumber) and the User insert that
   * follows are part of the same transaction — locking the row and then
   * committing/releasing before the caller inserts the User would defeat
   * the point.
   */
  async generate(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<string> {
    return issueDocumentNumber(tx, organizationId, 'employeeId');
  }
}
