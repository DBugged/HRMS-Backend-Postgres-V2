import { DashboardService } from './dashboard.service';

// Only the statutory-config lookup matters here; the rest of the service is not touched.
const build = (versions: Record<string, { isEnabled: boolean } | null>) => {
  const statutory = {
    getEffective: async (module: string) => ({
      date: '2026-10-31',
      version: versions[module]
        ? { config: {}, isEnabled: versions[module]!.isEnabled }
        : null,
    }),
  };
  return new DashboardService(
    {} as never,
    {} as never,
    {} as never,
    statutory as never,
  ) as unknown as {
    statutoryEnabledIn: (
      settings: Record<string, unknown>,
      organizationId: string,
      month: number,
      year: number,
    ) => Promise<{ pf: boolean; esi: boolean; pt: boolean; lwf: boolean }>;
  };
};

const settings = (over: Record<string, unknown> = {}) => ({
  financialYearStartMonth: 4,
  processingDay: 0,
  paymentDay: 0,
  roundingRule: 'nearest',
  roundingDecimals: 0,
  pfEnabled: false,
  esiEnabled: false,
  ptEnabled: false,
  lwfEnabled: false,
  npsEnabled: false,
  gratuityEnabled: false,
  bonusEnabled: false,
  incomeTaxEnabled: true,
  ptSlabs: [],
  ...over,
});

describe('dashboard: which statutory totals apply', () => {
  it('a version enabled in Statutory Configuration counts even when the Payroll Settings flag is off', async () => {
    const svc = build({ PF: { isEnabled: true }, ESI: { isEnabled: true } });
    expect(await svc.statutoryEnabledIn(settings(), 'org', 10, 2026)).toEqual({
      pf: true,
      esi: true,
      pt: false,
      lwf: false,
    });
  });

  it('a version switched off wins over a Payroll Settings flag that is still on', async () => {
    const svc = build({ PF: { isEnabled: false } });
    const r = await svc.statutoryEnabledIn(
      settings({ pfEnabled: true, ptEnabled: true }),
      'org',
      10,
      2026,
    );
    expect(r.pf).toBe(false);
    // No PT version: the flag decides.
    expect(r.pt).toBe(true);
  });

  it('with no versions at all, the Payroll Settings flags decide', async () => {
    const svc = build({});
    expect(
      await svc.statutoryEnabledIn(
        settings({ esiEnabled: true, lwfEnabled: true }),
        'org',
        10,
        2026,
      ),
    ).toEqual({ pf: false, esi: true, pt: false, lwf: true });
  });
});
