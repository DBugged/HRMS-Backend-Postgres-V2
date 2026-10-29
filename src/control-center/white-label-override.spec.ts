import { BadRequestException } from '@nestjs/common';
import { CcBillingService } from './cc-billing.service';

type Row = Record<string, any>;

function build(org: Row | null) {
  const upserts: Row[] = [];
  const svc = Object.create(CcBillingService.prototype) as any;
  svc.prisma = {
    ccFeatureFlag: { findUnique: async () => ({ key: 'x' }) },
    organization: { findFirst: async () => org },
    ccFlagOverride: { upsert: async (a: Row) => { upserts.push(a); return { value: a.create.value, updatedAt: new Date(), organization: { name: 'Acme', companyName: 'Acme' } }; } },
  };
  svc.modules = { clear: () => undefined };
  return { svc: svc as CcBillingService, upserts };
}

describe('turning on white label', () => {
  it('is refused until the company has uploaded its logo', async () => {
    const { svc, upserts } = build({ id: 'o1', companyLogoUrl: null });
    await expect(svc.setOverride('feature.white_label', 'o1', true)).rejects.toThrow(BadRequestException);
    expect(upserts).toHaveLength(0);
  });

  it('is allowed once the logo is there, and turning it off never needs a logo', async () => {
    const withLogo = build({ id: 'o1', companyLogoUrl: 'o1/logo.png' });
    await withLogo.svc.setOverride('feature.white_label', 'o1', true);
    expect(withLogo.upserts).toHaveLength(1);
    const noLogo = build({ id: 'o1', companyLogoUrl: null });
    await noLogo.svc.setOverride('feature.white_label', 'o1', false);
    expect(noLogo.upserts).toHaveLength(1);
  });

  it('does not touch other flags', async () => {
    const { svc, upserts } = build({ id: 'o1', companyLogoUrl: null });
    await svc.setOverride('feature.sister_companies', 'o1', true);
    expect(upserts).toHaveLength(1);
  });
});
