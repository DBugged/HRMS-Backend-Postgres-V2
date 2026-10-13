// Purpose: The one-page "Salary Structure" document - company letterhead, who it is for, and the CTC breakdown.
// Responsibilities: reads the employee's salary structure as of a date, builds the same breakdown the Salary Details
//   screen shows, and renders it as a PDF. Used by the Print button on the web, the PDF download on mobile, and as the
//   attachment mailed to the employee after a salary revision.
// Important: it states what is on the structure, so the person asking must already be allowed to see it (the
//   controller gates that); nothing here checks the caller.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as path from 'path';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { readStoredFile } from '../files/file-storage.config';
import { attachWatermark } from '../common/pdf-watermark';
import { FONTS_DIR, ROBOTO_FILES } from '../common/fonts-dir';
import { todayInOrgTz } from '../common/org-date';
import {
  breakdownStructure,
  resolveCurrentRows,
  synthesizeMissingRows,
  type StructureBreakdown,
} from './salary-structure-math';

const PAGE_W = 595.28; // A4 portrait, points
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const INK_900 = '#14161d';
const INK_600 = '#4c5262';
const BORDER = '#cfd4dc';
const SHADE = '#f1f3f7';
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface SalaryStructureDocInput {
  companyName: string;
  companyAddress: string;
  companyLogoBuffer: Buffer | null;
  watermarkEnabled: boolean;
  employeeName: string;
  employeeCode: string;
  designation: string;
  joiningDate: string;
  effectiveFrom: string;
  breakdown: StructureBreakdown;
}

const inr = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// "2026-04-01" -> "April, 2026"
export function monthYear(iso: string | null): string {
  if (!iso) return '-';
  const [y, m] = iso.slice(0, 10).split('-');
  const idx = Number(m) - 1;
  return MONTHS[idx] ? `${MONTHS[idx]}, ${y}` : iso;
}

// "2024-10-23" -> "23/10/2024"
function dmy(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

export function renderSalaryStructurePdf(
  input: SalaryStructureDocInput,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // Roboto, not the built-in Helvetica: Helvetica has no ₹ glyph.
    doc.registerFont('SS-Regular', path.join(FONTS_DIR, ROBOTO_FILES.regular));
    doc.registerFont('SS-Bold', path.join(FONTS_DIR, ROBOTO_FILES.bold));
    if (input.watermarkEnabled) attachWatermark(doc, input.companyLogoBuffer);

    // Letterhead: name and address left, logo right.
    const top = 36;
    const logoSize = 56;
    const textW = CONTENT_W - (input.companyLogoBuffer ? logoSize + 16 : 0);
    doc.font('SS-Bold').fontSize(15).fillColor(INK_900);
    doc.text(input.companyName, MARGIN, top, { width: textW });
    if (input.companyAddress) {
      doc.font('SS-Regular').fontSize(9).fillColor(INK_600);
      doc.text(input.companyAddress, MARGIN, doc.y + 2, { width: textW });
    }
    if (input.companyLogoBuffer) {
      try {
        doc.image(
          input.companyLogoBuffer,
          MARGIN + CONTENT_W - logoSize,
          top - 4,
          { fit: [logoSize, logoSize] },
        );
      } catch {
        // an unsupported image (an SVG logo) - the document stands without it
      }
    }
    let y = Math.max(doc.y, top + logoSize) + 12;
    doc
      .moveTo(MARGIN, y)
      .lineTo(MARGIN + CONTENT_W, y)
      .strokeColor(BORDER)
      .stroke();
    y += 22;

    doc.font('SS-Bold').fontSize(18).fillColor(INK_900);
    doc.text('SALARY STRUCTURE', MARGIN, y, { width: CONTENT_W });
    y = doc.y + 16;

    // Who it is for: four labelled values across the page.
    const cols = [
      {
        label: 'Employee Name',
        value: `${input.employeeName}, ${input.employeeCode}`,
        w: 190,
      },
      { label: 'Designation', value: input.designation || '-', w: 150 },
      { label: 'Date of Joining', value: dmy(input.joiningDate), w: 100 },
      {
        label: 'Salary Effective From',
        value: monthYear(input.effectiveFrom),
        w: 0,
      },
    ];
    cols[3].w = CONTENT_W - cols[0].w - cols[1].w - cols[2].w;
    let x = MARGIN;
    let rowBottom = y;
    for (const c of cols) {
      doc.font('SS-Regular').fontSize(9).fillColor(INK_600);
      doc.text(c.label, x, y, { width: c.w - 8 });
      doc.font('SS-Bold').fontSize(10.5).fillColor(INK_900);
      doc.text(c.value, x, doc.y + 2, { width: c.w - 8 });
      rowBottom = Math.max(rowBottom, doc.y);
      x += c.w;
    }
    y = rowBottom + 18;

    // The table.
    const colA = CONTENT_W * 0.5;
    const colB = CONTENT_W * 0.25;
    const colC = CONTENT_W * 0.25;
    const PAD = 10;
    const rowH = 24;
    const ensureRoom = (needed: number) => {
      if (y + needed > doc.page.height - MARGIN) {
        doc.addPage();
        y = MARGIN;
      }
    };
    const box = (yy: number, h: number, fill?: string) => {
      if (fill) doc.rect(MARGIN, yy, CONTENT_W, h).fill(fill);
      doc.rect(MARGIN, yy, CONTENT_W, h).strokeColor(BORDER).stroke();
      doc
        .moveTo(MARGIN + colA, yy)
        .lineTo(MARGIN + colA, yy + h)
        .stroke();
      doc
        .moveTo(MARGIN + colA + colB, yy)
        .lineTo(MARGIN + colA + colB, yy + h)
        .stroke();
    };
    const line = (
      label: string,
      monthly: string,
      annual: string,
      opts: {
        bold?: boolean;
        fill?: string;
        sub?: string | null;
        h?: number;
      } = {},
    ) => {
      const h = opts.h ?? (opts.sub ? rowH + 12 : rowH);
      ensureRoom(h);
      box(y, h, opts.fill);
      doc
        .font(opts.bold ? 'SS-Bold' : 'SS-Regular')
        .fontSize(10.5)
        .fillColor(INK_900);
      doc.text(label, MARGIN + PAD, y + 7, { width: colA - PAD * 2 });
      if (opts.sub) {
        doc.font('SS-Regular').fontSize(8.5).fillColor(INK_600);
        doc.text(opts.sub, MARGIN + PAD, doc.y + 1, { width: colA - PAD * 2 });
      }
      doc
        .font(opts.bold ? 'SS-Bold' : 'SS-Regular')
        .fontSize(10.5)
        .fillColor(INK_900);
      doc.text(monthly, MARGIN + colA, y + 7, {
        width: colB - PAD,
        align: 'right',
      });
      doc.text(annual, MARGIN + colA + colB, y + 7, {
        width: colC - PAD,
        align: 'right',
      });
      y += h;
    };
    const heading = (text: string) =>
      line(text, '', '', { bold: true, h: rowH + 4 });

    // header row
    ensureRoom(rowH + 4);
    box(y, rowH + 4);
    doc.font('SS-Bold').fontSize(10).fillColor(INK_900);
    doc.text('SALARY COMPONENTS', MARGIN + PAD, y + 9, {
      width: colA - PAD * 2,
    });
    doc.text('MONTHLY AMOUNT', MARGIN + colA, y + 9, {
      width: colB - PAD,
      align: 'right',
    });
    doc.text('ANNUAL AMOUNT', MARGIN + colA + colB, y + 9, {
      width: colC - PAD,
      align: 'right',
    });
    y += rowH + 4;

    const b = input.breakdown;
    heading('Earnings');
    for (const e of b.earnings) {
      line(e.name, inr(e.monthly), inr(e.annual), { sub: e.basis });
    }
    const extras = [...b.variable, ...b.oneTime];
    if (extras.length > 0) {
      heading('One Time Earnings');
      for (const v of extras) {
        const label = /variable/i.test(v.name)
          ? v.name
          : `${v.name} (Variable)`;
        line(label, '', inr(v.annual));
      }
    }
    line('COST TO COMPANY', inr(b.fixedMonthly), inr(b.annualCTC), {
      bold: true,
      fill: SHADE,
      h: rowH + 4,
    });
    doc.end();
  });
}

@Injectable()
export class SalaryStructurePdfService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  async build(
    employeeId: string,
    organizationId: string,
    asOfParam?: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const [org, employee] = await Promise.all([
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: {
          companyName: true,
          registeredAddress: true,
          companyLogoUrl: true,
          watermarkLogo: true,
          timezone: true,
        },
      }),
      this.scopedPrisma.user.findFirst({
        where: { id: employeeId, organizationId },
        select: {
          name: true,
          employeeId: true,
          designation: true,
          joiningDate: true,
        },
      }),
    ]);
    if (!employee) throw new NotFoundException('Employee not found.');
    const asOf = asOfParam ?? todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');

    const [rows, components] = await Promise.all([
      this.scopedPrisma.employeeSalaryComponent.findMany({
        where: { organizationId, employeeId },
        include: {
          component: {
            select: {
              name: true,
              type: true,
              payFrequency: true,
              isEmployerContribution: true,
              displayOrder: true,
            },
          },
        },
      }),
      this.scopedPrisma.salaryComponent.findMany({
        where: { organizationId, isActive: true },
      }),
    ]);
    const withRef = rows.map((r) => ({ ...r, componentRef: r.component }));
    const nameByCode = Object.fromEntries(
      components.map((c) => [c.code, c.name]),
    );
    const current = resolveCurrentRows(withRef, asOf);
    const synthesized = synthesizeMissingRows(withRef, components, asOf);
    const breakdown = breakdownStructure(
      [...current, ...synthesized],
      nameByCode,
    );
    if (breakdown.annualCTC <= 0) {
      throw new BadRequestException(
        'This employee has no salary structure on file yet.',
      );
    }
    const logo = org?.companyLogoUrl
      ? await readStoredFile(org.companyLogoUrl).catch(() => null)
      : null;
    const buffer = await renderSalaryStructurePdf({
      companyName: org?.companyName || 'the Company',
      companyAddress: org?.registeredAddress || '',
      companyLogoBuffer: logo,
      watermarkEnabled: !!org?.watermarkLogo,
      employeeName: employee.name,
      employeeCode: employee.employeeId,
      designation: employee.designation || '',
      joiningDate: employee.joiningDate
        ? new Date(employee.joiningDate).toISOString().slice(0, 10)
        : '',
      effectiveFrom: breakdown.effectiveFrom ?? asOf,
      breakdown,
    });
    const filename = `${`${employee.employeeId}-Salary Structure`
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()}.pdf`;
    return { buffer, filename };
  }
}
