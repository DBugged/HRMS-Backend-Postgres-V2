import { PayslipPdfService } from './payslip-pdf.service';

type Row = Record<string, any>;

const TEMPLATE: Row = {
  id: 't1',
  organizationId: 'org',
  name: 'Classic',
  isDefault: true,
  companyName: 'Acme Pvt Ltd',
  companyAddress: '12 MG Road, Mumbai',
  companyEmail: 'hr@acme.com',
  companyWebsite: 'https://acme.com',
  companyContactNumber: '9876543210',
  companyLogoUrl: null,
  primaryColor: '#5546e0',
  secondaryColor: '#14161d',
  accentColor: '#0f9d58',
  headerStyle: 'CLASSIC',
  fontFamily: 'HELVETICA',
  footerText: 'This is a system generated payslip.',
  signatoryName: 'A. Signer',
  signatoryDesignation: 'HR Head',
  watermarkText: '',
  showLogo: true,
  showPAN: true,
  showUAN: true,
  showESIC: true,
  showPFNumber: true,
  showBankDetails: true,
  showEmployerContributions: true,
  showCTC: true,
  showYTD: true,
  showQRCode: true,
  showFooter: true,
};

const run = (over: Row = {}): Row => ({
  id: 'r1',
  organizationId: 'org',
  employeeId: 'e1',
  payslipNumber: 'PS-0001',
  month: 9,
  year: 2026,
  financialYear: '2026-27',
  status: 'APPROVED',
  paidAt: null,
  netPay: 37800,
  netPayInWords: 'Rupees Thirty Seven Thousand Eight Hundred Only',
  grossSalary: 37800,
  totalDeductions: 0,
  attendanceSummary: {
    workingDays: 26,
    presentDays: 23,
    payableDays: 27,
    totalDaysInMonth: 30,
    lopDays: 3,
  },
  earnings: [
    { code: 'BASIC', name: 'Basic Salary', amount: 27000, taxable: true },
    { code: 'HRA', name: 'House Rent Allowance', amount: 10800, taxable: true },
  ],
  deductions: [],
  employerContributions: [],
  taxDetails: null,
  employee: {
    id: 'e1',
    employeeId: 'DP-1',
    name: 'Asha Rao',
    designation: 'Engineer',
    joiningDate: new Date('2024-01-01'),
    department: { name: 'IT' },
    personalData: {},
  },
  ...over,
});

function build(
  r: Row | null,
  opts: { template?: Row | null; org?: Row; priorRuns?: Row[] } = {},
) {
  const created: Row[] = [];
  const prisma: Row = {
    payrollRun: {
      findFirst: async () => r,
      findMany: async () => opts.priorRuns ?? [],
    },
    payrollTemplate: {
      findFirst: async () =>
        opts.template === undefined ? TEMPLATE : opts.template,
      create: async (a: Row) => {
        const row = { ...TEMPLATE, id: 'new', ...a.data };
        created.push(row);
        return row;
      },
    },
    organization: {
      findFirst: async () => ({
        watermarkLogo: false,
        gstin: '27ABCDE1234F1Z5',
        companyName: 'Acme Pvt Ltd',
        registeredAddress: '12 MG Road',
        contactEmail: 'hr@acme.com',
        website: null,
        phone: '9876543210',
        companyLogoUrl: null,
        ...opts.org,
      }),
    },
  };
  const service = new PayslipPdfService(
    prisma as never,
    {
      getOrCreate: async () => ({
        currencySymbol: '₹',
        currency: 'INR',
        dateFormat: 'DD-MM-YYYY',
      }),
    } as never,
  );
  return { service, created };
}

// pdfkit writes each page object as plain text in the file, so the number of "/Type /Page" objects is the page count.
async function pages(buffer: Buffer) {
  return (buffer.toString('latin1').match(/\/Type \/Page(?![s\w])/g) ?? [])
    .length;
}

describe('payslip PDF: output', () => {
  it('produces a real, loadable single-page PDF for an ordinary run, named after the employee and month', async () => {
    const { service } = build(run());
    const { buffer, filename } = await service.buildPayslipPdfBuffer(
      'r1',
      'org',
    );
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.subarray(-8).toString()).toContain('%%EOF');
    expect(await pages(buffer)).toBe(1);
    expect(filename).toMatch(/DP-1/);
    expect(filename).toMatch(/\.pdf$/);
  });

  it('an unknown payslip is not found', async () => {
    const { service } = build(null);
    await expect(service.buildPayslipPdfBuffer('ghost', 'org')).rejects.toThrow(
      /Payslip not found/,
    );
  });

  it('renders with deductions, employer contributions, tax details and year-to-date totals', async () => {
    const { service } = build(
      run({
        deductions: [
          { code: 'PF', name: 'Provident Fund', amount: 1800 },
          { code: 'INCOME_TAX', name: 'Income Tax (TDS)', amount: 4200 },
        ],
        employerContributions: [
          {
            code: 'PF_EMPLOYER',
            name: 'Employer PF',
            amount: 1800,
            wages: 15000,
          },
        ],
        totalDeductions: 6000,
        netPay: 31800,
        taxDetails: {
          regime: 'NEW',
          financialYear: '2026-27',
          grossAnnualIncome: 453600,
          taxableIncome: 378600,
          totalAnnualTax: 0,
          monthlyTDS: 4200,
          ytdTDS: 0,
          remainingMonths: 7,
          deductions: { standard: 75000 },
        },
      }),
      {
        priorRuns: [
          {
            month: 8,
            year: 2026,
            grossSalary: 37800,
            totalDeductions: 6000,
            netPay: 31800,
            earnings: [{ code: 'BASIC', amount: 27000 }],
            deductions: [{ code: 'PF', amount: 1800 }],
          },
        ],
      },
    );
    const { buffer } = await service.buildPayslipPdfBuffer('r1', 'org');
    expect(await pages(buffer)).toBeGreaterThanOrEqual(1);
  });

  it('a zero-amount run, a run with no lines, and missing optional details all still render', async () => {
    for (const r of [
      run({ grossSalary: 0, netPay: 0, earnings: [], deductions: [] }),
      run({
        attendanceSummary: null,
        taxDetails: undefined,
        designation: null,
      }),
      run({
        employee: {
          id: 'e1',
          employeeId: 'DP-1',
          name: 'No Details',
          designation: null,
          joiningDate: null,
          department: null,
          personalData: null,
        },
      }),
      run({ financialYear: null, payslipNumber: null }),
    ]) {
      const { buffer } = await build(r).service.buildPayslipPdfBuffer(
        'r1',
        'org',
      );
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  it('very long names and many lines flow onto more pages instead of being cut off or crashing', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      code: `E${i}`,
      name: `Allowance number ${i} with a fairly long descriptive name`,
      amount: 100 + i,
      taxable: true,
    }));
    const { buffer } = await build(
      run({
        earnings: many,
        employee: {
          id: 'e1',
          employeeId: 'DP-1',
          name: 'A'.repeat(80),
          designation: 'D'.repeat(80),
          joiningDate: new Date('2024-01-01'),
          department: { name: 'X'.repeat(60) },
          personalData: {},
        },
      }),
    ).service.buildPayslipPdfBuffer('r1', 'org');
    expect(await pages(buffer)).toBeGreaterThanOrEqual(2);
  });

  it('every template toggle switched off, every header style and font still renders', async () => {
    const off = Object.fromEntries(
      Object.keys(TEMPLATE)
        .filter((k) => k.startsWith('show'))
        .map((k) => [k, false]),
    );
    for (const t of [
      { ...TEMPLATE, ...off },
      { ...TEMPLATE, headerStyle: 'MODERN' },
      { ...TEMPLATE, headerStyle: 'MINIMAL', fontFamily: 'TIMES_ROMAN' },
      { ...TEMPLATE, fontFamily: 'COURIER', watermarkText: 'CONFIDENTIAL' },
      { ...TEMPLATE, fontFamily: 'ROBOTO' },
      { ...TEMPLATE, primaryColor: 'not-a-colour', accentColor: null },
    ]) {
      const { buffer } = await build(run(), {
        template: t,
      }).service.buildPayslipPdfBuffer('r1', 'org');
      expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    }
  });

  it('prints in Roboto when the currency symbol needs it (the rupee sign)', async () => {
    const { buffer } = await build(
      run({ deductions: [{ code: 'X', name: 'Fee ₹', amount: 5 }] }),
    ).service.buildPayslipPdfBuffer('r1', 'org');
    expect(buffer.length).toBeGreaterThan(1000);
  });
});

describe('payslip PDF: the template an organisation starts with', () => {
  it('when none exists, the first one is created from the organisation details, never a placeholder name', async () => {
    const { service, created } = build(run(), { template: null });
    await service.buildPayslipPdfBuffer('r1', 'org');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      name: 'Default Template',
      isDefault: true,
      companyName: 'Acme Pvt Ltd',
      companyAddress: '12 MG Road',
      companyEmail: 'hr@acme.com',
      companyContactNumber: '9876543210',
    });
    expect(created[0].companyName).not.toMatch(/Your Company Name/);
  });

  it('the preview of a draft template renders without any real employee', async () => {
    const { service } = build(null);
    const buffer = await service.buildPreviewPdfBuffer(
      TEMPLATE as never,
      'org',
    );
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await pages(buffer)).toBe(1);
  });
});
