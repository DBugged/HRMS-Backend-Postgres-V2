import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { formatDocumentNumber, issueDocumentNumber } from '../organizations/document-numbering';

/**
 * Employee ID generation. A person in a company brand that has its own ID series takes the next number of that series; everyone else
 * (no brand, or a brand without its own series) takes the next number of the organization's 'employeeId' Document Numbering
 * config (issueDocumentNumber), exactly as before.
 *
 * Must be called with a transaction client (`tx` from `prisma.$transaction(async (tx) => ...)`), so the row lock and the User insert
 * that follows are part of the same transaction.
 */
@Injectable()
export class EmployeeIdService {
  async generate(
    tx: Prisma.TransactionClient,
    organizationId: string,
    brandId?: string | null,
  ): Promise<string> {
    if (brandId) {
      const rows = await tx.$queryRaw<{ employeeIdFormat: string | null; employeeIdCounter: number }[]>`
        SELECT "employeeIdFormat", "employeeIdCounter" FROM company_brands
        WHERE id = ${brandId} AND "organizationId" = ${organizationId} FOR UPDATE
      `;
      const brand = rows[0];
      if (brand?.employeeIdFormat) {
        let counter = brand.employeeIdCounter;
        // An ID is unique across the company: a number somebody already holds is skipped, never reused.
        for (let tries = 0; tries < 50; tries++) {
          counter += 1;
          const id = formatDocumentNumber(brand.employeeIdFormat, counter);
          const taken = await tx.user.findFirst({ where: { organizationId, employeeId: id }, select: { id: true } });
          if (!taken) {
            await tx.companyBrand.update({ where: { id: brandId }, data: { employeeIdCounter: counter } });
            return id;
          }
        }
        throw new Error('Could not issue a free employee ID for this company series.');
      }
    }
    return issueDocumentNumber(tx, organizationId, 'employeeId');
  }
}
