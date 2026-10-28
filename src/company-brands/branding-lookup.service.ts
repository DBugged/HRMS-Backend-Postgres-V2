// Purpose: answers "which company name, logo and address go on this person's document?" in one place.
// Responsibilities: forEmployee() / forBrand() return the resolved branding - the employee's brand where it has a value, the organization's
//   own otherwise - so payslips, letters and emails all read the same answer.
// Important: no brand (or no brands at all) returns the organization's own branding exactly, so a company that never adds a brand is
//   unaffected by anything that calls this.
import { Inject, Injectable } from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { sisterCompaniesOn } from '../module-access/module-gate';
import { resolveBranding, type ResolvedBranding } from './brand-rules';

@Injectable()
export class BrandingLookupService {
  constructor(@Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient) {}

  /** The branding for one brand id (null = the organization's own). */
  async forBrand(organizationId: string, brandIdIn: string | null | undefined): Promise<ResolvedBranding> {
    // With sister companies switched off, every document carries the organization's own branding, whatever tags exist.
    const brandId = brandIdIn && (await sisterCompaniesOn(organizationId)) ? brandIdIn : null;
    const [org, brand] = await Promise.all([
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: { name: true, companyName: true, legalName: true, companyLogoUrl: true, emailLogoUrl: true, registeredAddress: true, contactEmail: true, phone: true, website: true },
      }),
      brandId ? this.scopedPrisma.companyBrand.findFirst({ where: { id: brandId, organizationId } }) : Promise.resolve(null),
    ]);
    return resolveBranding(
      org ?? { name: '', companyName: null, legalName: null, companyLogoUrl: null, emailLogoUrl: null, registeredAddress: null, contactEmail: null, phone: null, website: null },
      brand,
    );
  }

  /** The branding for one employee's documents. */
  async forEmployee(organizationId: string, employeeId: string): Promise<ResolvedBranding> {
    const user = await this.scopedPrisma.user.findFirst({ where: { id: employeeId, organizationId }, select: { brandId: true } });
    return this.forBrand(organizationId, user?.brandId);
  }
}
