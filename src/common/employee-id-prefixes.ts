// Purpose: every employee ID prefix already in use, across ALL companies, so a new company (or a changed format) never reuses one -
//   which is what lets an employee sign in with their employee ID alone.
// Responsibilities: reads the employee ID format of every organization and of every company brand (sister company) and returns their
//   prefixes (e.g. 'DC-'). Organization is not tenant-scoped; company brands are read with a raw query so the scope guard does not apply.
import type { Prisma } from '@prisma/client';
import { employeeIdPrefixOf } from '../company-brands/brand-rules';

type Db = Pick<Prisma.TransactionClient, 'organization' | '$queryRaw'>;

export async function takenEmployeeIdPrefixes(db: Db, exceptOrganizationId?: string): Promise<string[]> {
  const [orgs, brands] = await Promise.all([
    db.organization.findMany({ where: exceptOrganizationId ? { id: { not: exceptOrganizationId } } : {}, select: { documentNumbering: true } }),
    db.$queryRaw<{ format: string | null; organizationId: string }[]>`SELECT "employeeIdFormat" AS format, "organizationId" FROM company_brands WHERE "employeeIdFormat" IS NOT NULL`,
  ]);
  const out: string[] = [];
  for (const o of orgs) {
    const f = (o.documentNumbering as { employeeId?: { format?: string } } | null)?.employeeId?.format;
    const p = employeeIdPrefixOf(f);
    if (p) out.push(p);
  }
  for (const b of brands) {
    if (exceptOrganizationId && b.organizationId === exceptOrganizationId) continue;
    const p = employeeIdPrefixOf(b.format);
    if (p) out.push(p);
  }
  return out;
}
