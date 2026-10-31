// Purpose: the monthly "Expense Reimbursement Form" (Excel) - one sheet per employee, laid out like the company's paper form:
//   letterhead, employee and period details, a numbered table of that month's expenses with a total, the employee
//   declaration, the manager's approval and the accounts-only block.
// Responsibilities: pure layout from plain data (no database); ReimbursementsService gathers the data.
import ExcelJS from 'exceljs';

export interface ReimbursementFormLine {
  date: string; // DD-MM-YYYY, as printed
  category: string;
  description: string;
  amount: number;
  receipt: boolean;
}

export interface ReimbursementFormData {
  company: { name: string; address: string; contactLine: string; city: string };
  employee: { name: string; code: string; department: string; designation: string; email: string; mobile: string };
  number: string; // e.g. REIM-202610-DP-00002
  periodFrom: string; // DD-MM-YYYY
  periodTo: string;
  lines: ReimbursementFormLine[];
  // Manager / department-head block.
  approval: { decision: string; remarks: string; date: string };
  // Accounts block.
  paymentProcessedOn: string;
}

export const MIN_FORM_ROWS = 11;
const FONT = 'Calibri';
const thin = { style: 'thin' as const };
const medium = { style: 'medium' as const };

// An Excel sheet name: at most 31 characters, none of  \ / ? * [ ] :  and unique within the workbook.
export function sheetNameFor(base: string, taken: Set<string>): string {
  const clean = base.replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Form';
  let name = clean;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = clean.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(name.toLowerCase());
  return name;
}

function addForm(wb: ExcelJS.Workbook, form: ReimbursementFormData, sheetName: string): void {
  const ws = wb.addWorksheet(sheetName, {
    views: [{ showGridLines: false }],
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  });
  // A and H are the thin frame columns; B-G carry the form.
  const widths = [2, 8, 14, 22, 38, 15, 18, 2];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  let r = 1;
  const merge = (row: number, c1: string, c2: string) => ws.mergeCells(`${c1}${row}:${c2}${row}`);
  const put = (
    addr: string,
    value: ExcelJS.CellValue,
    o: { size?: number; bold?: boolean; h?: 'left' | 'center' | 'right'; wrap?: boolean; border?: Partial<ExcelJS.Borders>; numFmt?: string } = {},
  ) => {
    const cell = ws.getCell(addr);
    cell.value = value;
    cell.font = { name: FONT, size: o.size ?? 12, bold: o.bold ?? false };
    cell.alignment = { horizontal: o.h, vertical: 'middle', wrapText: o.wrap ?? true };
    if (o.border) cell.border = o.border;
    if (o.numFmt) cell.numFmt = o.numFmt;
  };
  const box: Partial<ExcelJS.Borders> = { left: thin, right: thin, top: thin, bottom: thin };

  // Letterhead.
  merge(1, 'B', 'G'); merge(2, 'B', 'G');
  put('B1', form.company.name, { size: 20, bold: true, h: 'center' });
  ws.getRow(1).height = 28; ws.getRow(2).height = 6;
  merge(3, 'B', 'G'); put('B3', form.company.address, { h: 'center' }); ws.getRow(3).height = 34;
  ws.mergeCells('B4:G5'); put('B4', form.company.contactLine, { h: 'center' });
  merge(6, 'B', 'G');
  merge(7, 'B', 'G'); put('B7', 'Expense Reimbursement Form', { size: 16, bold: true, h: 'center', border: box }); ws.getRow(7).height = 26;
  merge(8, 'B', 'G'); put('B8', `Reimbursement No.: ${form.number}`, { bold: true, border: { left: thin, right: thin } });

  // Employee / period.
  ws.mergeCells('B9:D9'); put('B9', `Name: ${form.employee.name}`, { bold: true, border: { left: thin } });
  put('E9', `Department: ${form.employee.department}`, { bold: true });
  ws.mergeCells('F9:G9'); put('F9', `Period From: ${form.periodFrom}`, { bold: true, border: { right: thin } });
  ws.mergeCells('B10:D10'); put('B10', `Employee ID: ${form.employee.code}`, { bold: true, border: { left: thin } });
  put('E10', `Designation: ${form.employee.designation}`, { bold: true });
  ws.mergeCells('F10:G10'); put('F10', `To: ${form.periodTo}`, { bold: true, border: { right: thin } });
  ws.mergeCells('B11:D11'); put('B11', `Email ID: ${form.employee.email}`, { bold: true, border: { left: thin, bottom: thin } });
  put('E11', `Mobile No.: ${form.employee.mobile}`, { bold: true, border: { bottom: thin } });
  ws.mergeCells('F11:G11'); put('F11', '', { border: { right: thin, bottom: thin } });
  [9, 10, 11].forEach((n) => { ws.getRow(n).height = 22; });
  merge(12, 'B', 'G');
  ws.mergeCells('B13:G14'); put('B13', 'Reimbursement Details:', { size: 14, bold: true, border: box });

  // Table.
  const head = ['Sr.No', 'Date', 'Expense Category', 'Description of Expense', 'Amount (₹)', 'Receipt Attached (Y/N)'];
  ['B', 'C', 'D', 'E', 'F', 'G'].forEach((col, i) => put(`${col}15`, head[i], { bold: true, h: 'center', border: box }));
  ws.getRow(15).height = 34;
  const rows = Math.max(MIN_FORM_ROWS, form.lines.length);
  const first = 16;
  for (let i = 0; i < rows; i++) {
    const row = first + i;
    const line = form.lines[i];
    put(`B${row}`, i + 1, { h: 'center', border: box });
    put(`C${row}`, line?.date ?? '', { h: 'center', border: box });
    put(`D${row}`, line?.category ?? '', { h: 'center', border: box });
    put(`E${row}`, line?.description ?? '', { h: 'left', border: box });
    put(`F${row}`, line ? line.amount : null, { h: 'right', border: box, numFmt: '#,##0.00' });
    put(`G${row}`, line ? (line.receipt ? 'Y' : 'N') : '', { h: 'center', border: box });
    ws.getRow(row).height = line && line.description.length > 40 ? 32 : 20;
  }
  const last = first + rows - 1;
  const totalRow = last + 1;
  ws.mergeCells(`B${totalRow}:E${totalRow}`);
  put(`B${totalRow}`, 'TOTAL (₹)', { size: 14, bold: true, h: 'right', border: box });
  const total = Math.round(form.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  ws.getCell(`F${totalRow}`).value = { formula: `SUM(F${first}:F${last})`, result: total };
  ws.getCell(`F${totalRow}`).font = { name: FONT, size: 14, bold: true };
  ws.getCell(`F${totalRow}`).alignment = { horizontal: 'right', vertical: 'middle' };
  ws.getCell(`F${totalRow}`).numFmt = '#,##0.00';
  ws.getCell(`F${totalRow}`).border = box;
  put(`G${totalRow}`, '', { border: box });
  ws.getRow(totalRow).height = 24;

  // Declarations and approvals.
  r = totalRow + 2;
  const block = (text: string, o: Parameters<typeof put>[2] = {}) => {
    merge(r, 'B', 'G');
    put(`B${r}`, text, o);
    r += 1;
  };
  block('Declarations & Approvals', { size: 14, bold: true });
  block('Employee Declaration: ', { bold: true });
  ws.getRow(r).height = 34;
  block('I hereby declare that the information provided is accurate, and the expenses were incurred for official purposes only.');
  r += 1;
  block('Signature of Employee: ', { bold: true });
  merge(r, 'B', 'C'); put(`B${r}`, 'Date: ', { bold: true });
  merge(r, 'D', 'G'); put(`D${r}`, `Place: ${form.company.city}`, { bold: true });
  r += 2;
  block('Manager/Department Head Approval: ', { size: 14, bold: true });
  block(`Approved / Not Approved: ${form.approval.decision}`);
  block(`Remarks (if any): ${form.approval.remarks || 'NA'}`);
  ws.getRow(r - 1).height = form.approval.remarks.length > 90 ? 34 : 20;
  block('Signature: ');
  block(`Date: ${form.approval.date}`);
  r += 1;
  block('Accounts Department Use Only:', { size: 14, bold: true });
  block('Verified By: ');
  block('Date: ');
  block(`Payment Processed On: ${form.paymentProcessedOn}`);
  block('Transaction ID / Reference No.: ');
  const end = r - 1;

  // The frame around the whole form: thin side columns, a medium outline.
  ws.mergeCells(`A1:A${end}`);
  ws.mergeCells(`H1:H${end}`);
  ws.getCell('A1').border = { left: medium, top: medium, bottom: medium };
  ws.getCell('H1').border = { right: medium, top: medium, bottom: medium };
  ['B', 'C', 'D', 'E', 'F', 'G'].forEach((col) => {
    const top = ws.getCell(`${col}1`);
    top.border = { ...(top.border ?? {}), top: medium };
    const bottom = ws.getCell(`${col}${end}`);
    bottom.border = { ...(bottom.border ?? {}), bottom: medium };
  });
  ws.pageSetup.printArea = `A1:H${end}`;
}

export async function buildReimbursementFormWorkbook(forms: ReimbursementFormData[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'D\'Core HR';
  const taken = new Set<string>();
  for (const f of forms) addForm(wb, f, sheetNameFor(`${f.employee.name} (${f.employee.code})`, taken));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
