// Purpose: Renders the Form 130 (Form 16 before 1-Apr-2026) salary TDS certificate PDF from Form130Data.
// Important: This is the employer-prepared copy built from payroll records. The certificate that is legally valid
//   is the one generated on TRACES from the filed quarterly statements — the footer says so on every page.
import PDFDocument from 'pdfkit';
import type { TdsComplianceService } from './tds-compliance.service';
import { detectRasterExtension } from '../reports/report-export';

type Form130Data = Awaited<ReturnType<TdsComplianceService['form130Data']>>;

const MARGIN = 40;
const PAGE_W = 595.28;
const CONTENT_W = PAGE_W - MARGIN * 2;
const INK = '#14161d';
const MUTED = '#4c5262';
const LINE = '#cfd4de';

const SECTION_LABEL: Record<string, string> = {
  section80C: 'section 80C',
  section80CCD1B: 'section 80CCD(1B)',
  section80CCD2: 'section 80CCD(2)',
  section80D: 'section 80D',
  section80E: 'section 80E',
  section80G: 'section 80G',
  section80TTA: 'section 80TTA',
  homeLoanInterest: 'section 24(b) home-loan interest',
  other: 'other deductions',
};

const rs = (n: number) => `Rs. ${Math.round(n).toLocaleString('en-IN')}`;
const dmy = (iso: string) => {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
};

export function renderForm130(
  data: Form130Data,
  logoBuffer?: Buffer | null,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: MARGIN,
      bufferPages: true,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ty = `Tax Year ${data.financialYear}`;
    let y = MARGIN;

    const ensure = (h: number) => {
      if (y + h > 841.89 - 60) {
        doc.addPage();
        y = MARGIN;
      }
    };
    const heading = (t: string) => {
      ensure(30);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(t, MARGIN, y);
      y += 16;
      doc
        .moveTo(MARGIN, y - 3)
        .lineTo(MARGIN + CONTENT_W, y - 3)
        .strokeColor(LINE)
        .stroke();
    };
    const kv = (k: string, v: string, x = MARGIN, w = CONTENT_W / 2 - 8) => {
      doc
        .font('Helvetica')
        .fontSize(7.5)
        .fillColor(MUTED)
        .text(k, x, y, { width: w });
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor(INK)
        .text(v || '-', x, y + 9, { width: w });
    };
    const kvRow = (a: [string, string], b?: [string, string]) => {
      ensure(30);
      kv(a[0], a[1]);
      if (b) kv(b[0], b[1], MARGIN + CONTENT_W / 2 + 8);
      y += 30;
    };
    const table = (head: string[], rows: string[][], widths: number[]) => {
      const draw = (cells: string[], bold: boolean) => {
        ensure(18);
        let x = MARGIN;
        doc
          .font(bold ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(8)
          .fillColor(INK);
        const h = Math.max(
          ...cells.map((c, i) =>
            doc.heightOfString(c, { width: widths[i] - 6 }),
          ),
          12,
        );
        cells.forEach((c, i) => {
          doc.text(c, x + 3, y + 2, {
            width: widths[i] - 6,
            align: i === 0 ? 'left' : 'right',
          });
          x += widths[i];
        });
        y += h + 5;
        doc
          .moveTo(MARGIN, y - 2)
          .lineTo(MARGIN + CONTENT_W, y - 2)
          .strokeColor(LINE)
          .stroke();
      };
      draw(head, true);
      rows.forEach((r) => draw(r, false));
      y += 6;
    };

    // Org Report Logo, top-right. pdfkit only decodes PNG/JPEG/GIF, so anything else is skipped.
    let titleW = CONTENT_W;
    if (logoBuffer && detectRasterExtension(logoBuffer)) {
      try {
        doc.image(logoBuffer, MARGIN + CONTENT_W - 48, MARGIN, {
          fit: [48, 48],
          align: 'right',
        });
        titleW = CONTENT_W - 60;
      } catch {
        /* unreadable image - issue the certificate without it */
      }
    }
    doc
      .font('Helvetica-Bold')
      .fontSize(15)
      .fillColor(INK)
      .text(
        `${data.formName} — Certificate of Tax Deducted at Source on Salary`,
        MARGIN,
        y,
        { width: titleW },
      );
    y += 22;
    doc
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(
        `${ty}${data.formName === 'Form 130' ? ' (Income-tax Act, 2025, section 392)' : ' (section 203, Income-tax Act, 1961)'}`,
        MARGIN,
        y,
      );
    y += 20;

    heading('PART A — Employer and employee');
    kvRow(
      ['Name of the deductor (employer)', data.employer.name],
      ['Employer address', data.employer.address],
    );
    kvRow(
      ['Employer PAN', data.employer.pan],
      ['Employer TAN', data.employer.tan],
    );
    kvRow(
      ['Employer e-mail', data.employer.email],
      ['Employer contact number', data.employer.phone],
    );
    kvRow(
      ['Name of the employee', data.employee.name],
      [
        'Employee ID / designation',
        `${data.employee.code} / ${data.employee.designation || '-'}`,
      ],
    );
    kvRow(
      ['Employee PAN', data.employee.pan],
      ['Employee address', data.employee.address],
    );
    kvRow(
      ['Period of employment — from', dmy(data.period.from)],
      ['Period of employment — to', dmy(data.period.to)],
    );
    y += 4;

    heading('PART B — Salary paid and tax deducted, deposited (quarter-wise)');
    table(
      [
        'Quarter',
        'Statement receipt no.',
        'Amount paid / credited',
        'Tax deducted',
        'Tax deposited',
      ],
      [
        ...data.quarters.map((q) => [
          `Q${q.quarter}`,
          q.receiptNumber ?? 'not filed yet',
          rs(q.amountPaid),
          rs(q.tdsDeducted),
          rs(q.tdsDeposited),
        ]),
        [
          'Total',
          '',
          rs(data.totals.amountPaid),
          rs(data.totals.tdsDeducted),
          rs(data.totals.tdsDeposited),
        ],
      ],
      [60, 150, 110, 100, 95],
    );

    heading(
      `PART C — Annexure I: computation of income and tax (${data.annexure.regime} regime)`,
    );
    const a = data.annexure;
    const rows: string[][] = [
      ['Gross salary paid by this employer', rs(a.grossSalary)],
      ['Salary taxable (excluding non-taxable payments)', rs(a.taxableSalary)],
      [
        'Gross total income (incl. previous employer / other income)',
        rs(a.grossTotalIncome),
      ],
      ['Less: exemption — house rent allowance', rs(a.exemptionHra)],
      ['Less: exemption — leave travel concession', rs(a.exemptionLta)],
      ['Less: standard deduction', rs(a.standardDeduction)],
      ...a.chapter6a.map((c): string[] => [
        `Less: deduction — ${SECTION_LABEL[c.section] ?? c.section}`,
        rs(c.amount),
      ]),
      ['Total income (taxable)', rs(a.totalIncome)],
      ['Tax on total income', rs(a.taxOnIncome)],
      ['Less: rebate u/s 87A', rs(a.rebate)],
      ['Add: surcharge', rs(a.surcharge)],
      ['Add: health and education cess', rs(a.cess)],
      ...(a.relief89 > 0
        ? [['Less: relief u/s 89 (Form 10E)', rs(a.relief89)]]
        : []),
      ['Net tax payable', rs(a.netTaxPayable)],
      ['Less: tax deducted by previous employer', rs(a.previousEmployerTds)],
      ['Less: tax deducted by this employer', rs(a.tdsDeducted)],
      ['Balance tax payable / (refundable)', rs(a.balance)],
    ];
    table(['Particulars', 'Amount'], rows, [CONTENT_W - 140, 140]);

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i += 1) {
      doc.switchToPage(i);
      doc
        .font('Helvetica-Oblique')
        .fontSize(6.8)
        .fillColor(MUTED)
        .text(
          `Prepared by the employer from payroll records on ${dmy(data.issuedAt)}. ${
            data.traces
              ? 'Quarterly statements are on record; the certificate generated on TRACES is the valid one.'
              : 'Quarterly statements are not all filed — this is a draft and not a valid certificate.'
          }  Page ${i + 1} of ${range.count}`,
          MARGIN,
          841.89 - 44,
          { width: CONTENT_W, align: 'center', lineBreak: false },
        );
    }
    doc.end();
  });
}
