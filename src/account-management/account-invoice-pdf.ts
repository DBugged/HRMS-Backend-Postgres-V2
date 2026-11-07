// Purpose: the PDF of one invoice, drawn from the stored invoice record only (company, line items, totals). Nothing is invented: a
//   field with no value is left off.
import PDFDocument from 'pdfkit';

export interface InvoicePdfInput {
  number: string;
  date: Date;
  dueDate: Date | null;
  status: string;
  currency: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  paidAt: Date | null;
  paymentRef: string | null;
  lineItems: { description?: string; quantity?: number; unitAmount?: number }[];
  billedTo: { name: string; address: string | null };
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

export function buildInvoicePdf(input: InvoicePdfInput): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // The standard fonts have no rupee sign, so amounts are written with the currency code (INR 1,200.00).
    const money = (n: number) => `${input.currency} ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const right = doc.page.width - 48;

    doc.font('Helvetica-Bold').fontSize(20).text('Invoice', 48, 48);
    doc.font('Helvetica').fontSize(10).fillColor('#555555');
    doc.text(`Invoice number: ${input.number}`, 48, 80);
    doc.text(`Date: ${fmtDate(input.date)}`);
    if (input.dueDate) doc.text(`Due date: ${fmtDate(input.dueDate)}`);
    doc.text(`Status: ${input.status}`);
    if (input.paidAt) doc.text(`Paid on: ${fmtDate(input.paidAt)}${input.paymentRef ? ` (ref ${input.paymentRef})` : ''}`);

    doc.fillColor('#000000').font('Helvetica-Bold').fontSize(11).text('Billed to', 340, 80);
    doc.font('Helvetica').fontSize(10).text(input.billedTo.name, 340, 96, { width: right - 340 });
    if (input.billedTo.address) doc.text(input.billedTo.address, { width: right - 340 });

    let y = 190;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Description', 48, y);
    doc.text('Qty', 340, y, { width: 40, align: 'right' });
    doc.text('Unit price', 390, y, { width: 70, align: 'right' });
    doc.text('Amount', 470, y, { width: right - 470, align: 'right' });
    y += 16;
    doc.moveTo(48, y).lineTo(right, y).strokeColor('#cccccc').stroke();
    y += 8;
    doc.font('Helvetica').fillColor('#000000');
    for (const l of input.lineItems) {
      const qty = Number(l.quantity ?? 0);
      const unit = Number(l.unitAmount ?? 0);
      const h = doc.heightOfString(l.description ?? '', { width: 280 });
      doc.text(l.description ?? '', 48, y, { width: 280 });
      doc.text(String(qty), 340, y, { width: 40, align: 'right' });
      doc.text(money(unit), 390, y, { width: 70, align: 'right' });
      doc.text(money(qty * unit), 470, y, { width: right - 470, align: 'right' });
      y += Math.max(h, 14) + 6;
      if (y > doc.page.height - 160) {
        doc.addPage();
        y = 48;
      }
    }
    y += 6;
    doc.moveTo(300, y).lineTo(right, y).strokeColor('#cccccc').stroke();
    y += 10;
    const row = (label: string, value: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, 300, y, { width: 100 });
      doc.text(value, 400, y, { width: right - 400, align: 'right' });
      y += 16;
    };
    row('Subtotal', money(input.subtotal));
    if (input.discount > 0) row('Discount', `- ${money(input.discount)}`);
    if (input.tax > 0) row('Tax', money(input.tax));
    row('Total', money(input.total), true);
    doc.end();
  });
}
