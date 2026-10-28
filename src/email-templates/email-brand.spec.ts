import { EmailTemplatesService } from './email-templates.service';

type Row = Record<string, any>;

function build(brand: Row | null) {
  let asked = 0;
  const prisma: Row = {
    emailTemplate: { findFirst: async () => null },
    emailSignature: { findFirst: async () => null, findMany: async () => [] },
    organization: {
      findFirst: async () => ({
        name: 'parent', companyName: 'Parent Co', phone: '111', website: 'https://parent.test', contactEmail: 'hr@parent.test',
        registeredAddress: 'Parent Street', emailLogoUrl: 'org/email.png', companyLogoUrl: null, primaryColor: null,
      }),
    },
  };
  const lookup = { forBrand: async () => { asked++; return brand; } };
  const svc = new EmailTemplatesService(prisma as never, {} as never, {} as never, lookup as never);
  return { svc, asked: () => asked };
}

const BRAND = { brandId: '11111111-1111-1111-1111-111111111111', companyName: 'Sister A', phone: '222', website: null, contactEmail: null, address: 'A Street', emailLogoUrl: 'org/a.png' };
const render = (svc: EmailTemplatesService, opts?: Row) =>
  svc.renderOccasion('org', 'SOME_KEY', {}, { subject: 'Hello', html: '<p>Hi</p>' }, opts);

describe('email header and footer branding', () => {
  it('uses the organization when no brand is given, without asking for one', async () => {
    const { svc, asked } = build(BRAND);
    const { html } = await render(svc);
    expect(html).toContain('Parent Co');
    expect(html).not.toContain('Sister A');
    expect(asked()).toBe(0);
  });

  it('uses the brand name and its own logo link when a brand is given', async () => {
    const { svc } = build(BRAND);
    const { html } = await render(svc, { brandId: BRAND.brandId });
    expect(html).toContain('Sister A');
    expect(html).toContain(`/brands/${BRAND.brandId}/email-logo`);
    expect(html).not.toContain('Parent Co');
  });

  it('keeps the organization when the brand no longer resolves', async () => {
    const { svc } = build({ ...BRAND, brandId: null });
    const { html } = await render(svc, { brandId: 'gone' });
    expect(html).toContain('Parent Co');
  });
});
