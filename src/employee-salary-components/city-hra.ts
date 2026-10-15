// Purpose: Make the auto-applied HRA follow where the employee works: 50% of Basic in a metro city, 40% in any other
//   city, none in a village (see defaultHraPercent). Without it every employee without a saved HRA line got the
//   org-wide HRA component's flat percentage (40%) whatever their work location.
// Responsibilities: pick the employee's city class (own work location, else the department's) and return the component
//   list with HRA's percentage swapped for that class's. An employee's own saved HRA line is never touched - it wins
//   over the component wherever overrides are applied.
// Important: only the stock shape is replaced - an HRA component HR changed into a formula, or into a percentage of
//   something other than Basic, is a deliberate choice and is left alone.
import { CalcType } from '@prisma/client';
import { effectiveWorkLocation } from '../common/effective-work-location';
import { defaultHraPercent, type CityClassName } from '../common/hra-cities';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';

interface HraCandidate {
  code: string;
  calcType: CalcType;
  percentageOf?: string | null;
  percentageValue?: number | null;
}

/** HRA's percentage of Basic for this class; every other component comes back unchanged. */
export function withCityHra<T extends HraCandidate>(
  components: T[],
  cityClass: CityClassName,
): T[] {
  const percent = defaultHraPercent(cityClass);
  return components.map((c) =>
    c.code === 'HRA' &&
    c.calcType === CalcType.PERCENTAGE &&
    c.percentageOf === 'BASIC'
      ? { ...c, percentageValue: percent }
      : c,
  );
}

/** METRO / NON_METRO / RURAL of the employee's effective work location; NON_METRO when they have none. */
export async function employeeCityClass(
  prisma: ExtendedPrismaClient,
  employeeId: string,
  organizationId: string,
): Promise<CityClassName> {
  const employee = await prisma.user.findFirst({
    where: { id: employeeId, organizationId },
    select: {
      workLocation: { select: { cityClass: true } },
      department: { select: { workLocation: { select: { cityClass: true } } } },
    },
  });
  return (
    (employee && effectiveWorkLocation(employee)?.cityClass) || 'NON_METRO'
  );
}
