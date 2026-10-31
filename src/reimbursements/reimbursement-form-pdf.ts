// Purpose: the monthly "Expense Reimbursement Form" as a professional PDF - letterhead with the company logo, an employee and
//   period card, the numbered expense table with a total (and the amount in words), the declaration with signature lines, and
//   side-by-side manager-approval and accounts blocks. One form per employee, each starting on its own page; a long table
//   flows onto the next page and repeats its header. Every page carries a footer with the page number.
// Responsibilities: pure layout from ReimbursementFormData (no database).
import * as path from 'path';
import PDFDocument from 'pdfkit';
import { FONTS_DIR, ROBOTO_FILES } from '../common/fonts-dir';
import type { ReimbursementFormData } from './reimbursement-form';
import { rupeesInWords } from './rupees-in-words';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 36; // margin
const W = PAGE_W - M * 2;
const INK = '#16202e';
const MUTED = '#5b6677';
const FAINT = '#8a93a3';
const ACCENT = '#1f3a5f';
const ACCENT_SOFT = '#eaf0f7';
const LINE = '#cfd6e0';
const ZEBRA = '#f6f8fb';
const GREEN = '#127a4b';
const AMBER = '#a05a00';
// Sr.No, Date, Category, Description, Amount, Receipt - sums to W (523.28)
const COLS = [34, 66, 78, 215.28, 70, 60];
const FOOTER_H = 30;
// A printed page keeps a few spare numbered rows (the Excel form keeps eleven); more are added when there are more claims.
const PDF_MIN_ROWS = 6;

const money = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function renderOne(doc: PDFKit.PDFDocument, f: ReimbursementFormData): void {
  let y = M;
  const text = (s: string, x: number, yy: number, o: { w?: number; size?: number; bold?: boolean; align?: 'left' | 'center' | 'right'; color?: string; spacing?: number } = {}) => {
    doc.font(o.bold ? 'Bold' : 'Reg').fontSize(o.size ?? 10).fillColor(o.color ?? INK)
      .text(s, x, yy, { width: o.w ?? W, align: o.align ?? 'left', characterSpacing: o.spacing ?? 0 });
  };
  const heightOf = (s: string, w: number, size: number, bold = false) => {
    doc.font(bold ? 'Bold' : 'Reg').fontSize(size);
    return doc.heightOfString(s, { width: w });
  };
  const fillRect = (x: number, yy: number, w: number, h: number, color: string, r = 0) => {
    doc.fillColor(color);
    if (r) doc.roundedRect(x, yy, w, h, r).fill();
    else doc.rect(x, yy, w, h).fill();
  };
  const strokeRect = (x: number, yy: number, w: number, h: number, r = 0, color = LINE) => {
    doc.lineWidth(0.8).strokeColor(color);
    if (r) doc.roundedRect(x, yy, w, h, r).stroke();
    else doc.rect(x, yy, w, h).stroke();
  };
  const hline = (x1: number, x2: number, yy: number, color = LINE, width = 0.8) => {
    doc.lineWidth(width).strokeColor(color).moveTo(x1, yy).lineTo(x2, yy).stroke();
  };
  const bottom = () => PAGE_H - M - FOOTER_H;
  const ensure = (h: number) => {
    if (y + h > bottom()) { doc.addPage(); y = M; }
  };

  // ---- Letterhead: accent bar, logo, company name and contact details -------------------------------------------------
  fillRect(0, 0, PAGE_W, 8, ACCENT);
  y = M + 6;
  const logoBox = 54;
  let textX = M;
  if (f.company.logo) {
    try {
      doc.image(f.company.logo, M, y, { fit: [logoBox + 20, logoBox], valign: 'center' });
      textX = M + logoBox + 28;
    } catch { /* an unreadable logo is skipped; the name still heads the form */ }
  }
  const textW = PAGE_W - M - textX;
  const align = textX === M ? 'left' : 'left';
  text(f.company.name, textX, y, { size: 17, bold: true, color: ACCENT, w: textW, align });
  let ty = y + 23;
  if (f.company.address) {
    const flat = f.company.address.replace(/,?\s*\n\s*/g, ', ');
    text(flat, textX, ty, { size: 8.5, color: MUTED, w: textW });
    ty += heightOf(flat, textW, 8.5) + 3;
  }
  const contact = [
    f.company.phone ? `Tel:\u00A0${f.company.phone}` : '',
    f.company.email ? `Email:\u00A0${f.company.email}` : '',
    f.company.website ? f.company.website.replace(/^https?:\/\//, '') : '',
    f.company.gstin ? `GSTIN:\u00A0${f.company.gstin}` : '',
  ].filter(Boolean).join('   |   ') || f.company.contactLine.replace(/\s{3,}/g, '   |   ');
  if (contact) {
    text(contact, textX, ty, { size: 8.5, color: MUTED, w: textW });
    ty += heightOf(contact, textW, 8.5);
  }
  y = Math.max(y + logoBox, ty) + 10;
  hline(M, M + W, y, LINE, 1);
  y += 12;

  // ---- Title band ----------------------------------------------------------------------------------------------------
  fillRect(M, y, W, 30, ACCENT, 3);
  text('EXPENSE REIMBURSEMENT FORM', M, y + 9, { size: 12.5, bold: true, color: '#ffffff', align: 'center', spacing: 1.2 });
  y += 38;

  // ---- Employee / period card ----------------------------------------------------------------------------------------
  const cardH = 86;
  fillRect(M, y, W, cardH, '#ffffff');
  strokeRect(M, y, W, cardH, 4);
  const colW = W / 3;
  const field = (label: string, value: string, cx: number, cy: number, w: number) => {
    text(label.toUpperCase(), cx, cy, { size: 6.8, color: FAINT, w, spacing: 0.5 });
    text(value || '—', cx, cy + 9, { size: 9.5, bold: true, w });
  };
  const px = 12;
  field('Employee name', f.employee.name, M + px, y + 9, colW - px * 2);
  field('Employee ID', f.employee.code, M + colW + px, y + 9, colW - px * 2);
  field('Reimbursement No.', f.number, M + colW * 2 + px, y + 9, colW - px * 2);
  field('Department', f.employee.department, M + px, y + 33, colW - px * 2);
  field('Designation', f.employee.designation, M + colW + px, y + 33, colW - px * 2);
  field('Period', `${f.periodFrom}  to  ${f.periodTo}`, M + colW * 2 + px, y + 33, colW - px * 2);
  field('Email', f.employee.email, M + px, y + 57, colW * 2 - px * 2);
  field('Mobile', f.employee.mobile, M + colW * 2 + px, y + 57, colW - px * 2);
  y += cardH + 14;

  // ---- Table ---------------------------------------------------------------------------------------------------------
  text('Reimbursement Details', M, y, { size: 11, bold: true, color: ACCENT });
  y += 17;
  const drawHeader = () => {
    const h = 28;
    fillRect(M, y, W, h, ACCENT, 3);
    const head = ['Sr.No', 'Date', 'Expense Category', 'Description of Expense', 'Amount (₹)', 'Receipt (Y/N)'];
    let x = M;
    head.forEach((t, i) => {
      text(t, x + 4, y + 9, { size: 8.5, bold: true, color: '#ffffff', align: i === 3 ? 'left' : i === 4 ? 'right' : 'center', w: COLS[i] - 8 });
      x += COLS[i];
    });
    y += h;
  };
  ensure(80);
  drawHeader();
  const n = Math.max(PDF_MIN_ROWS, f.lines.length);
  for (let i = 0; i < n; i++) {
    const line = f.lines[i];
    const descH = line ? heightOf(line.description, COLS[3] - 10, 9) : 0;
    const h = Math.max(19, descH + 9);
    if (y + h > bottom() - 40) { doc.addPage(); y = M; drawHeader(); }
    if (i % 2 === 1) fillRect(M, y, W, h, ZEBRA);
    let x = M;
    const cells = [String(i + 1), line?.date ?? '', line?.category ?? '', line?.description ?? '', line ? money(line.amount) : '', line ? (line.receipt ? 'Y' : 'N') : ''];
    cells.forEach((t, j) => {
      if (t) {
        const color = j === 5 ? (t === 'Y' ? GREEN : AMBER) : j === 0 && !line ? FAINT : INK;
        text(t, x + 5, y + 5.5, { size: 9, w: COLS[j] - 10, align: j === 3 ? 'left' : j === 4 ? 'right' : 'center', bold: j === 5, color });
      }
      x += COLS[j];
    });
    hline(M, M + W, y + h, LINE, 0.5);
    y += h;
  }
  // Total.
  const total = Math.round(f.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  fillRect(M, y + 4, W, 26, ACCENT_SOFT, 3);
  text('TOTAL (₹)', M, y + 12, { size: 11, bold: true, color: ACCENT, align: 'right', w: COLS[0] + COLS[1] + COLS[2] + COLS[3] - 8 });
  text(money(total), M + COLS[0] + COLS[1] + COLS[2] + COLS[3], y + 11, { size: 12, bold: true, color: ACCENT, align: 'right', w: COLS[4] + COLS[5] - 6 });
  y += 34;
  text(`Amount in words: ${rupeesInWords(total)}`, M, y, { size: 8.5, color: MUTED });
  y += 20;

  // ---- Declaration -----------------------------------------------------------------------------------------------------
  ensure(215);
  const decl = 'I hereby declare that the information provided is accurate, and the expenses were incurred for official purposes only.';
  const declH = heightOf(decl, W - 24, 9) + 34;
  fillRect(M, y, W, declH, ZEBRA, 4);
  text('EMPLOYEE DECLARATION', M + 12, y + 8, { size: 7.5, bold: true, color: ACCENT, spacing: 0.6 });
  text(decl, M + 12, y + 21, { size: 9, color: INK, w: W - 24 });
  y += declH + 22;
  // Signature lines.
  const sigW = (W - 40) / 3;
  const sig = (label: string, value: string, sx: number) => {
    if (value) text(value, sx, y - 12, { size: 9, bold: true, w: sigW });
    hline(sx, sx + sigW, y, '#9aa3b2', 0.8);
    text(label, sx, y + 3, { size: 7.5, color: FAINT, w: sigW });
  };
  sig('Signature of employee', '', M);
  sig('Date', '', M + sigW + 20);
  sig('Place', f.company.city, M + (sigW + 20) * 2);
  y += 28;

  // ---- Approval and accounts blocks, side by side ----------------------------------------------------------------------
  const gap = 14;
  const bw = (W - gap) / 2;
  const bh = 128;
  ensure(bh + 6);
  const block = (title: string, x: number) => {
    strokeRect(x, y, bw, bh, 4);
    fillRect(x, y, bw, 22, ACCENT_SOFT, 4);
    text(title.toUpperCase(), x + 10, y + 7, { size: 7.5, bold: true, color: ACCENT, w: bw - 20, spacing: 0.5 });
  };
  const lineField = (label: string, value: string, x: number, yy: number) => {
    text(label, x + 10, yy, { size: 7.5, color: FAINT, w: bw - 20 });
    if (value) text(value, x + 10, yy + 9, { size: 9, bold: true, w: bw - 20 });
    hline(x + 10, x + bw - 10, yy + 22, LINE, 0.6);
  };
  block('Manager / Department Head Approval', M);
  const decisionColor = f.approval.decision === 'Approved' ? GREEN : f.approval.decision === 'Pending' ? AMBER : INK;
  text('DECISION', M + 10, y + 30, { size: 7.5, color: FAINT, w: bw - 20 });
  text(f.approval.decision, M + 10, y + 39, { size: 10, bold: true, color: decisionColor, w: bw - 20 });
  lineField('Remarks', f.approval.remarks || 'NA', M, y + 56);
  lineField('Signature', '', M, y + 82);
  text('DATE', M + 10, y + 108, { size: 7.5, color: FAINT, w: 40 });
  text(f.approval.date, M + 40, y + 106, { size: 9, bold: true, w: bw - 50 });
  const bx = M + bw + gap;
  block('Accounts Department Use Only', bx);
  lineField('Verified by', '', bx, y + 30);
  lineField('Date', '', bx, y + 56);
  lineField('Payment processed on', f.paymentProcessedOn, bx, y + 82);
  lineField('Transaction ID / reference no.', '', bx, y + 108 - 4);
  y += bh;
}

export function renderReimbursementFormPdf(forms: ReimbursementFormData[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, autoFirstPage: false, bufferPages: true, info: { Title: 'Expense Reimbursement Form' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('Reg', path.join(FONTS_DIR, ROBOTO_FILES.regular));
    doc.registerFont('Bold', path.join(FONTS_DIR, ROBOTO_FILES.bold));
    for (const f of forms) {
      doc.addPage();
      renderOne(doc, f);
    }
    // Footer on every page: when it was made, and the page number.
    const generated = new Date();
    const stamp = `${String(generated.getDate()).padStart(2, '0')}-${String(generated.getMonth() + 1).padStart(2, '0')}-${generated.getFullYear()}`;
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // the footer sits inside the bottom margin; without this it would start a new page
      doc.lineWidth(0.6).strokeColor(LINE).moveTo(M, PAGE_H - M - 16).lineTo(M + W, PAGE_H - M - 16).stroke();
      doc.font('Reg').fontSize(7.5).fillColor(FAINT)
        .text(`Generated on ${stamp}   |   System-generated form`, M, PAGE_H - M - 10, { width: W / 2, align: 'left', lineBreak: false })
        .text(`Page ${i - range.start + 1} of ${range.count}`, M + W / 2, PAGE_H - M - 10, { width: W / 2, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
