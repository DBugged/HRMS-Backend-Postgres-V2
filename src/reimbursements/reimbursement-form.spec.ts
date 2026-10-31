import ExcelJS from 'exceljs';
import { renderReimbursementFormPdf } from './reimbursement-form-pdf';
import {
  buildReimbursementFormWorkbook,
  sheetNameFor,
  MIN_FORM_ROWS,
  type ReimbursementFormData,
} from './reimbursement-form';

const base = (lines: ReimbursementFormData['lines']): ReimbursementFormData => ({
  company: { name: "D'Bugged Programmers", address: '602, 9th Floor, Mumbai', contactLine: 'Email: info@x.com   GST: 27AAAAA0000A1Z5', city: 'Mumbai' },
  employee: { name: 'Asha Rao', code: 'DP-00002', department: 'Engineering', designation: 'Engineer', email: 'asha@x.com', mobile: '9999999999' },
  number: 'REIM-202610-DP-00002',
  periodFrom: '01-10-2026',
  periodTo: '31-10-2026',
  lines,
  approval: { decision: 'Approved', remarks: '', date: '30-10-2026' },
  paymentProcessedOn: '',
});
const line = (n: number) => ({ date: `0${n}-10-2026`, category: 'Travel', description: `Cab ${n}`, amount: 100 * n, receipt: n % 2 === 1 });

async function load(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe('reimbursement form workbook', () => {
  it('lays the form out like the paper form and totals the amounts', async () => {
    const wb = await load(await buildReimbursementFormWorkbook([base([line(1), line(2), line(3)])]));
    const ws = wb.worksheets[0];
    expect(ws.getCell('B1').value).toBe("D'Bugged Programmers");
    expect(ws.getCell('B7').value).toBe('Expense Reimbursement Form');
    expect(ws.getCell('B8').value).toBe('Reimbursement No.: REIM-202610-DP-00002');
    expect(ws.getCell('B9').value).toBe('Name: Asha Rao');
    expect(ws.getCell('F9').value).toBe('Period From: 01-10-2026');
    expect(ws.getCell('B15').value).toBe('Sr.No');
    expect(ws.getCell('G15').value).toBe('Receipt Attached (Y/N)');
    expect(ws.getCell('C16').value).toBe('01-10-2026');
    expect(ws.getCell('G16').value).toBe('Y');
    expect(ws.getCell('G17').value).toBe('N');
    // 11 numbered rows at least, then the total (formula over the rows).
    const totalRow = 16 + MIN_FORM_ROWS;
    expect(ws.getCell(`B${totalRow}`).value).toBe('TOTAL (₹)');
    const total = ws.getCell(`F${totalRow}`).value as { formula: string; result: number };
    expect(total.formula).toBe(`SUM(F16:F${totalRow - 1})`);
    expect(total.result).toBe(600);
  });

  it('adds rows beyond 11 instead of dropping claims', async () => {
    const lines = Array.from({ length: 14 }, (_, i) => ({ ...line(1), description: `Item ${i + 1}`, amount: 10 }));
    const wb = await load(await buildReimbursementFormWorkbook([base(lines)]));
    const ws = wb.worksheets[0];
    expect(ws.getCell('E29').value).toBe('Item 14');
    expect(ws.getCell('B30').value).toBe('TOTAL (₹)');
    expect((ws.getCell('F30').value as { result: number }).result).toBe(140);
  });

  it('makes one sheet per employee with safe, unique names', async () => {
    const wb = await load(await buildReimbursementFormWorkbook([base([line(1)]), base([line(2)])]));
    expect(wb.worksheets).toHaveLength(2);
    expect(wb.worksheets[0].name).not.toBe(wb.worksheets[1].name);
    const taken = new Set<string>();
    expect(sheetNameFor('A/B:C?*[x]'.padEnd(50, 'z'), taken).length).toBeLessThanOrEqual(31);
    expect(sheetNameFor('A/B:C?*[x]', taken)).not.toMatch(/[\\/?*[\]:]/);
  });
});

describe('reimbursement form PDF', () => {
  it('renders one form per employee as a PDF, with extra pages for long tables', async () => {
    const short = await renderReimbursementFormPdf([base([line(1)])]);
    expect(short.subarray(0, 5).toString()).toBe('%PDF-');
    const two = await renderReimbursementFormPdf([base([line(1)]), base([line(2)])]);
    const long = await renderReimbursementFormPdf([base(Array.from({ length: 30 }, (_, i) => ({ ...line(1), description: `Long item ${i + 1} `.repeat(6), amount: 5 })))]);
    // More forms or a longer table means a bigger document.
    expect(two.length).toBeGreaterThan(short.length);
    expect(long.length).toBeGreaterThan(short.length);
  });
});
