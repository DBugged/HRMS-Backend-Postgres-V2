import { CalcType } from '@prisma/client';
import { employeeCityClass, withCityHra } from './city-hra';
import { synthesizeMissingRows } from './salary-structure-math';

const hra = (over: Record<string, unknown> = {}) => ({
  id: 'c-hra',
  code: 'HRA',
  name: 'House Rent Allowance',
  type: 'EARNING' as const,
  calcType: CalcType.PERCENTAGE,
  percentageOf: 'BASIC',
  percentageValue: 40,
  formula: null,
  isActive: true,
  isEmployerContribution: false,
  payFrequency: 'MONTHLY',
  displayOrder: 2,
  ...over,
});

describe('withCityHra', () => {
  it.each([
    ['METRO', 50],
    ['NON_METRO', 40],
    ['RURAL', 0],
  ] as const)('%s class gives HRA %s%% of Basic', (cityClass, percent) => {
    const [out] = withCityHra([hra()], cityClass);
    expect(out.percentageValue).toBe(percent);
  });

  it('does not mutate the master component', () => {
    const master = hra();
    withCityHra([master], 'METRO');
    expect(master.percentageValue).toBe(40);
  });

  it('leaves other components alone', () => {
    const da = hra({ code: 'DA', percentageValue: 10 });
    expect(withCityHra([da], 'METRO')[0].percentageValue).toBe(10);
  });

  it('leaves an HRA that is a formula, or a percentage of something else, alone', () => {
    const formula = hra({ calcType: CalcType.FORMULA, percentageValue: null });
    const ofGross = hra({ percentageOf: 'GROSS' });
    expect(withCityHra([formula], 'METRO')[0]).toBe(formula);
    expect(withCityHra([ofGross], 'METRO')[0].percentageValue).toBe(40);
  });

  it('shows 50% on the synthesized structure row for a metro employee with no saved HRA line', () => {
    const rows = synthesizeMissingRows(
      [],
      withCityHra([hra()], 'METRO'),
      '2026-10-01',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].percentageValue).toBe(50);
  });

  it('keeps a saved HRA line: the synthesized row only fills the gap', () => {
    const saved = [{ componentCode: 'HRA' }] as never;
    expect(
      synthesizeMissingRows(saved, withCityHra([hra()], 'METRO'), '2026-10-01'),
    ).toEqual([]);
  });
});

describe('employeeCityClass', () => {
  const prismaReturning = (user: unknown) =>
    ({ user: { findFirst: jest.fn().mockResolvedValue(user) } }) as never;

  it("uses the employee's own work location", async () => {
    const prisma = prismaReturning({
      workLocation: { cityClass: 'METRO' },
      department: { workLocation: { cityClass: 'NON_METRO' } },
    });
    await expect(employeeCityClass(prisma, 'e1', 'o1')).resolves.toBe('METRO');
  });

  it("falls back to the department's work location", async () => {
    const prisma = prismaReturning({
      workLocation: null,
      department: { workLocation: { cityClass: 'RURAL' } },
    });
    await expect(employeeCityClass(prisma, 'e1', 'o1')).resolves.toBe('RURAL');
  });

  it('is NON_METRO with no location at all, or no such employee', async () => {
    await expect(
      employeeCityClass(
        prismaReturning({ workLocation: null, department: null }),
        'e1',
        'o1',
      ),
    ).resolves.toBe('NON_METRO');
    await expect(
      employeeCityClass(prismaReturning(null), 'e1', 'o1'),
    ).resolves.toBe('NON_METRO');
  });
});
