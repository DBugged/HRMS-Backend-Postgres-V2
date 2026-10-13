import {
  monthYear,
  renderSalaryStructurePdf,
} from './salary-structure-pdf.service';
import { breakdownStructure } from './salary-structure-math';

describe('salary structure document', () => {
  it('names the effective month and year', () => {
    expect(monthYear('2026-04-01')).toBe('April, 2026');
    expect(monthYear(null)).toBe('-');
  });

  it('renders a one-page PDF from a breakdown', async () => {
    const breakdown = breakdownStructure(
      [
        {
          componentCode: 'BASIC',
          valueType: 'FIXED',
          fixedAmount: 10800,
          effectiveFrom: '2026-04-01',
          componentRef: {
            name: 'Basic',
            type: 'EARNING',
            payFrequency: 'MONTHLY',
            displayOrder: 1,
          },
        },
        {
          componentCode: 'HRA',
          valueType: 'PERCENTAGE',
          percentageValue: 40,
          percentageOf: 'BASIC',
          effectiveFrom: '2026-04-01',
          componentRef: {
            name: 'House Rent Allowance',
            type: 'EARNING',
            payFrequency: 'MONTHLY',
            displayOrder: 2,
          },
        },
        {
          componentCode: 'VARIABLE_PAY',
          valueType: 'MANUAL',
          fixedAmount: 36000,
          amountBasis: 'MONTHLY',
          effectiveFrom: '2026-04-01',
          componentRef: {
            name: 'Performance Incentive',
            type: 'EARNING',
            payFrequency: 'YEARLY',
            displayOrder: 3,
          },
        },
      ],
      { BASIC: 'Basic' },
    );
    expect(breakdown.earnings.map((e) => e.name)).toEqual([
      'Basic',
      'House Rent Allowance',
    ]);
    expect(breakdown.earnings[1].basis).toBe('40% of Basic');
    expect(breakdown.effectiveFrom).toBe('2026-04-01');

    const buffer = await renderSalaryStructurePdf({
      companyName: "D'Bugged Programmers",
      companyAddress: '602, 9th Floor, Mumbai',
      companyLogoBuffer: null,
      watermarkEnabled: false,
      employeeName: 'Jigar Vekariya',
      employeeCode: 'DP00007',
      designation: 'Jr. Software Developer - Trainee',
      joiningDate: '2024-10-23',
      effectiveFrom: breakdown.effectiveFrom ?? '2026-04-01',
      breakdown,
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(1500);
  });
});
