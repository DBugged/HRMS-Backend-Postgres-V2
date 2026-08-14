import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import { PayrollRunStatus } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { formatDateDisplay, formatDateTimeDisplay } from './format-date';

/**
 * Pure port of the old backend's payslipPdfController.js — THE universal
 * payslip layout, every employee/every run renders through this same
 * template. Nothing here is per-tenant/per-employee custom; only the
 * *data* fed in varies (a component with no line in earnings/deductions
 * simply never appears, since the payroll engine never generated a line
 * for it) and the *branding/toggles* come from the active PayrollTemplate.
 *
 * Two deliberate scope reductions vs. the old system, both because the
 * underlying data source doesn't exist anywhere in backend-v2 yet:
 * - No company-logo embedding — no file-storage infrastructure exists
 *   (same deferral as PayrollTemplate.companyLogoUrl elsewhere).
 * - PAN/UAN/PF Number/ESIC/Bank Details rows always render '-' — no
 *   employee statutory/bank-details fields exist on User yet. The
 *   template's own showPAN/showUAN/etc. toggles are preserved so a future
 *   "Employee Statutory & Bank Details" batch lights these up for free.
 * PayrollTemplate itself needs no "Organization fallback" (unlike the old
 * system) — its company* fields already carry real DB-level defaults
 * (Batch 5b), so the old applyOrganizationFallback() has no equivalent
 * here.
 */

const MONTHS = [
  '',
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

const PAGE_W = 595.28; // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN = 32;
const CONTENT_W = PAGE_W - MARGIN * 2;

const INK_900 = '#14161d';
const INK_600 = '#4c5262';
const INK_400 = '#98a1b3';
const BORDER = '#e5e7eb';
const EARN_GREEN = '#0f9d58';
const DEDUCT_RED = '#d93025';

const FONT_MAP: Record<
  string,
  { regular: string; bold: string; oblique: string }
> = {
  HELVETICA: {
    regular: 'Helvetica',
    bold: 'Helvetica-Bold',
    oblique: 'Helvetica-Oblique',
  },
  TIMES_ROMAN: {
    regular: 'Times-Roman',
    bold: 'Times-Bold',
    oblique: 'Times-Italic',
  },
  COURIER: {
    regular: 'Courier',
    bold: 'Courier-Bold',
    oblique: 'Courier-Oblique',
  },
};

const safeHex = (hex: string | null | undefined, fallback: string) =>
  /^#[0-9a-fA-F]{6}$/.test(hex || '') ? (hex as string) : fallback;

interface PayrollLine {
  code: string;
  name: string;
  amount: number;
  taxable?: boolean;
}

interface YtdTotals {
  grossSalary: number;
  totalDeductions: number;
  netPay: number;
  earningsByCode: Record<string, number>;
  deductionsByCode: Record<string, number>;
}

@Injectable()
export class PayslipPdfService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly payrollSettingsService: PayrollSettingsService,
  ) {}

  async buildPayslipPdfBuffer(
    runId: string,
    organizationId: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const run = await this.scopedPrisma.payrollRun.findFirst({
      where: { id: runId, organizationId },
      include: {
        employee: {
          select: {
            id: true,
            name: true,
            employeeId: true,
            designation: true,
            joiningDate: true,
            department: { select: { name: true } },
          },
        },
      },
    });
    if (!run) throw new NotFoundException('Payslip not found.');

    const [template, settings, ytd] = await Promise.all([
      this.getActiveTemplate(organizationId),
      this.payrollSettingsService.getOrCreate(organizationId),
      run.financialYear
        ? this.computeYtdTotals(
            run.employeeId,
            run.financialYear,
            run.month,
            run.year,
            organizationId,
          )
        : Promise.resolve(null),
    ]);

    const rawSymbol = settings.currencySymbol || '₹';
    // pdfkit's standard 14 fonts only cover WinAnsi — the ₹ glyph isn't in
    // that set and renders as a broken glyph, so the PDF always falls back
    // to an ASCII-safe "Rs." regardless of the configured symbol (the web
    // UI elsewhere still renders ₹ fine via the browser's own font).

    const currencySymbol = /^[\x00-\x7F]+$/.test(rawSymbol) // eslint-disable-line no-control-regex -- ASCII-only check, not a stray control char
      ? rawSymbol
      : 'Rs.';
    const money = (n: number | null | undefined) =>
      `${currencySymbol}${currencySymbol === 'Rs.' ? ' ' : ''}${Number(n || 0).toLocaleString('en-IN')}`;

    const primary = safeHex(template.primaryColor, '#5546e0');
    const secondary = safeHex(template.secondaryColor, '#14161d');
    const headerColor = safeHex(template.headerColor, primary);
    const fonts = FONT_MAP[template.fontFamily] ?? FONT_MAP.HELVETICA;

    const deptName = run.employee.department?.name || '-';
    const earnings = run.earnings as unknown as PayrollLine[];
    const deductions = run.deductions as unknown as PayrollLine[];
    const employerContributions =
      run.employerContributions as unknown as PayrollLine[];

    const rowCount = Math.max(earnings.length, deductions.length, 1);
    const tableRowH = rowCount > 10 ? 11 : rowCount > 6 ? 13 : 15;
    const tableFontSize = rowCount > 10 ? 6.5 : 7.5;

    const qrBuffer = template.showQRCode
      ? await QRCode.toBuffer(
          `PAYSLIP|${run.id}|${run.employee.employeeId}|${run.month}-${run.year}|NET:${run.netPay}`,
          {
            type: 'png',
            margin: 0,
            width: 200,
            color: { dark: secondary, light: '#FFFFFFFF' },
          },
        ).catch(() => null)
      : null;

    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({
        margin: MARGIN,
        size: 'A4',
        bufferPages: true,
      });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const text = (
        str: string | number | null | undefined,
        x: number,
        y: number,
        opts: PDFKit.Mixins.TextOptions = {},
      ) => doc.text(String(str ?? ''), x, y, { lineBreak: false, ...opts });

      if (template.watermarkText) {
        doc.save();
        doc.rotate(-38, { origin: [PAGE_W / 2, PAGE_H / 2] });
        doc
          .font(fonts.bold)
          .fontSize(60)
          .fillColor('#000000')
          .fillOpacity(0.045)
          .text(template.watermarkText, 0, PAGE_H / 2 - 30, {
            width: PAGE_W,
            align: 'center',
            lineBreak: true,
          });
        doc.restore();
        doc.fillOpacity(1);
      }

      // ── Header band ──────────────────────────────────────────────────
      const headerH = 78;
      doc.rect(0, 0, PAGE_W, headerH).fill(headerColor);
      const textX = MARGIN;
      doc.font(fonts.bold).fontSize(15).fillColor('#FFFFFF');
      text(template.companyName, textX, 15, { width: 280 });
      let infoY = 34;
      if (template.showCompanyAddress && template.companyAddress) {
        doc.font(fonts.regular).fontSize(7.5).fillColor('#FFFFFF');
        text(template.companyAddress, textX, infoY, {
          width: 280,
          lineBreak: true,
        });
        infoY = doc.y + 1;
      }
      const contactBits = [
        template.companyEmail,
        template.companyContactNumber,
        template.companyWebsite,
      ]
        .filter(Boolean)
        .join('   |   ');
      if (contactBits) {
        doc.font(fonts.regular).fontSize(7.5).fillColor('#FFFFFF');
        text(contactBits, textX, infoY, { width: 280 });
      }

      doc.font(fonts.bold).fontSize(18).fillColor('#FFFFFF');
      text('PAYSLIP', PAGE_W - MARGIN - 220, 16, {
        width: 220,
        align: 'right',
      });
      const periodLabel = `${MONTHS[run.month]} ${run.year}`;
      doc.font(fonts.regular).fontSize(8.5).fillColor('#FFFFFF');
      text(periodLabel, PAGE_W - MARGIN - 220, 38, {
        width: 220,
        align: 'right',
      });
      const payDate = run.paidAt ? formatDateDisplay(run.paidAt) : '-';
      doc.fontSize(7.5);
      text(
        `Pay Period: ${MONTHS[run.month]} ${run.year}  |  Pay Date: ${payDate}`,
        PAGE_W - MARGIN - 220,
        54,
        { width: 220, align: 'right' },
      );

      // ── Three cards: Employee Details / Attendance Summary / Net Pay ──
      let y = headerH + 20;
      const cardH = 158;
      const gap = 10;
      const empW = Math.round(CONTENT_W * 0.48);
      const attW = Math.round(CONTENT_W * 0.27);
      const netW = CONTENT_W - empW - attW - gap * 2;
      const empX = MARGIN;
      const attX = empX + empW + gap;
      const netX = attX + attW + gap;

      doc.roundedRect(empX, y, empW, cardH, 8).fillAndStroke('#ffffff', BORDER);
      doc.font(fonts.bold).fontSize(8.5).fillColor(primary);
      text('EMPLOYEE DETAILS', empX + 10, y + 9);
      const empFields: [string, string][] = [
        ['Employee ID', run.employee.employeeId || '-'],
        ['Name', run.employee.name || '-'],
        ['Department', deptName],
        ['Designation', run.employee.designation || '-'],
        [
          'Date of Joining',
          run.employee.joiningDate
            ? formatDateDisplay(run.employee.joiningDate)
            : '-',
        ],
      ];
      // No employee statutory/bank-details fields exist yet — these rows
      // always show '-' until that data source is built (see class doc).
      if (template.showPAN) empFields.push(['PAN', '-']);
      if (template.showUAN) empFields.push(['UAN', '-']);
      if (template.showPFNumber) empFields.push(['PF Number', '-']);
      if (template.showESIC) empFields.push(['ESIC Number', '-']);
      if (template.showBankDetails) {
        empFields.push(['Bank Name', '-']);
        empFields.push(['Bank Account', '-']);
        empFields.push(['IFSC Code', '-']);
      }
      this.drawTwoColKV(
        doc,
        text,
        empFields,
        empX + 10,
        y + 24,
        empW - 20,
        fonts,
      );

      doc.roundedRect(attX, y, attW, cardH, 8).fillAndStroke('#ffffff', BORDER);
      doc.font(fonts.bold).fontSize(8.5).fillColor(primary);
      text('ATTENDANCE SUMMARY', attX + 10, y + 9, { width: attW - 20 });
      const a = run.attendanceSummary as unknown as Record<
        string,
        number | undefined
      >;
      // Field/label pairing ported verbatim from the old system, including
      // its apparent mislabeling (Weekly Offs shows weekendWorkDays —
      // weekend-overtime day count, not attendance.weeklyOffs; Holidays
      // shows holidayWorkDays — holiday-overtime day count, not
      // attendance.holidays). Not a calculation bug (display-only), ported
      // as-is rather than silently "corrected".
      const attFields: [string, string | number][] = [
        ['Working Days', a.workingDays ?? '-'],
        ['Present Days', a.presentDays ?? '-'],
        ['Weekly Offs', a.weekendWorkDays ?? '-'],
        ['Holidays', a.holidayWorkDays ?? '-'],
        ['Paid Leave', a.paidLeaveDays ?? '-'],
        ['LOP Days', a.lopDays ?? '-'],
        ['Half Days', a.halfDays ?? '-'],
        ['OT Hours', a.overtimeHours ?? '-'],
        [
          'Payable Days',
          a.payableDays != null
            ? `${a.payableDays}/${a.totalDaysInMonth ?? '-'}`
            : '-',
        ],
      ];
      this.drawOneColKV(
        doc,
        text,
        attFields,
        attX + 10,
        y + 24,
        attW - 20,
        fonts,
      );

      doc
        .roundedRect(netX, y, netW, cardH, 8)
        .fillAndStroke(secondary, secondary);
      doc.font(fonts.regular).fontSize(8).fillColor('#FFFFFF');
      text('NET PAY', netX + 10, y + 12);
      doc.font(fonts.bold).fontSize(19).fillColor('#FFFFFF');
      text(money(run.netPay), netX + 10, y + 26, { width: netW - 20 });
      doc.font(fonts.oblique).fontSize(6.6).fillColor('#d8d8e6');
      text(run.netPayInWords || '', netX + 10, y + 54, {
        width: netW - 20,
        lineBreak: true,
      });

      y += cardH + 20;

      // ── Earnings / Deductions ────────────────────────────────────────
      const colW = (CONTENT_W - gap) / 2;
      const leftX = MARGIN;
      const rightX = MARGIN + colW + gap;
      const amtColW = 62;
      const ytdColW = template.showYTD ? 52 : 0;
      const nameColW = colW - amtColW - ytdColW - 8;

      const earnEndY = this.drawLedgerTable(doc, text, {
        title: 'EARNINGS',
        x: leftX,
        y,
        width: colW,
        rows: earnings,
        color: EARN_GREEN,
        totalLabel: 'Gross Earnings',
        totalValue: run.grossSalary,
        ytdMap: ytd?.earningsByCode,
        ytdTotal: ytd?.grossSalary,
        showYtd: template.showYTD,
        nameColW,
        amtColW,
        ytdColW,
        rowH: tableRowH,
        fontSize: tableFontSize,
        fonts,
        money,
      });
      const dedEndY = this.drawLedgerTable(doc, text, {
        title: 'DEDUCTIONS',
        x: rightX,
        y,
        width: colW,
        rows: deductions,
        color: DEDUCT_RED,
        totalLabel: 'Total Deductions',
        totalValue: run.totalDeductions,
        ytdMap: ytd?.deductionsByCode,
        ytdTotal: ytd?.totalDeductions,
        showYtd: template.showYTD,
        nameColW,
        amtColW,
        ytdColW,
        rowH: tableRowH,
        fontSize: tableFontSize,
        fonts,
        money,
      });
      y = Math.max(earnEndY, dedEndY) + 18;

      // ── Net Payable highlighted band ──────────────────────────────────
      const bandH = 42;
      doc.roundedRect(MARGIN, y, CONTENT_W, bandH, 6).fill(primary);
      doc.font(fonts.bold).fontSize(11).fillColor('#FFFFFF');
      text('NET PAYABLE', MARGIN + 14, y + 8);
      doc.font(fonts.regular).fontSize(6.8).fillColor('#e8e7fb');
      text('Gross Earnings - Total Deductions', MARGIN + 14, y + 22);
      doc.font(fonts.bold).fontSize(16).fillColor('#FFFFFF');
      text(money(run.netPay), MARGIN, y + 9, {
        width: CONTENT_W - 14,
        align: 'right',
      });
      y += bandH + 18;

      // ── Employer contributions ─────────────────────────────────────────
      if (
        template.showEmployerContributions &&
        employerContributions.length > 0
      ) {
        doc.font(fonts.bold).fontSize(9).fillColor(INK_900);
        text('EMPLOYER CONTRIBUTIONS', MARGIN, y);
        y += 14;
        const ecColW = Math.min(
          140,
          CONTENT_W / Math.min(employerContributions.length, 4),
        );
        employerContributions.slice(0, 4).forEach((c, i) => {
          doc.font(fonts.regular).fontSize(7.2).fillColor(INK_600);
          text(c.name, MARGIN + i * ecColW, y, { width: ecColW - 8 });
          doc.font(fonts.bold).fontSize(9).fillColor(INK_900);
          text(money(c.amount), MARGIN + i * ecColW, y + 10, {
            width: ecColW - 8,
          });
        });
        y += 26;
        doc.font(fonts.oblique).fontSize(6.6).fillColor(INK_400);
        text(
          'Employer Contributions are not deducted from employee salary.',
          MARGIN,
          y,
        );
        y += 14;

        if (template.showCTC) {
          const totalCTC =
            (run.grossSalary || 0) +
            employerContributions.reduce((sum, c) => sum + (c.amount || 0), 0);
          doc.font(fonts.bold).fontSize(7.5).fillColor(INK_900);
          text('Total CTC (this period)', MARGIN, y);
          text(money(totalCTC), MARGIN, y, {
            width: CONTENT_W - 14,
            align: 'right',
          });
          y += 16;
        }
      }

      // ── Year to Date ────────────────────────────────────────────────────
      if (template.showYTD && ytd) {
        doc.font(fonts.bold).fontSize(9).fillColor(INK_900);
        text('YEAR TO DATE', MARGIN, y);
        y += 14;
        const ytdStats: [string, string][] = [
          ['Gross Earnings YTD', money(ytd.grossSalary)],
          ['Total Deductions YTD', money(ytd.totalDeductions)],
          ['Net Pay YTD', money(ytd.netPay)],
        ];
        const statW = CONTENT_W / 3;
        ytdStats.forEach(([label, val], i) => {
          doc.font(fonts.regular).fontSize(7).fillColor(INK_400);
          text(label, MARGIN + i * statW, y, { width: statW - 10 });
          doc.font(fonts.bold).fontSize(10).fillColor(INK_900);
          text(val, MARGIN + i * statW, y + 10, { width: statW - 10 });
        });
        y += 30;
      }

      // ── Footer ──────────────────────────────────────────────────────────
      if (template.showFooter) {
        const footerY = Math.min(y + 4, PAGE_H - 96);
        doc
          .moveTo(MARGIN, footerY)
          .lineTo(PAGE_W - MARGIN, footerY)
          .strokeColor(BORDER)
          .stroke();
        let fy = footerY + 8;
        doc.font(fonts.oblique).fontSize(7).fillColor(INK_600);
        text(`Amount in Words: ${run.netPayInWords || '-'}`, MARGIN, fy, {
          width: CONTENT_W - 74,
          lineBreak: true,
        });
        fy = Math.max(doc.y + 3, fy + 10);
        doc.font(fonts.regular).fontSize(6.5).fillColor(INK_400);
        text(`Generated on ${formatDateTimeDisplay(new Date())}`, MARGIN, fy, {
          width: CONTENT_W - 74,
        });
        fy += 9;
        text(
          `Generated by: ${template.companyName} HRMS  |  Digitally Verified`,
          MARGIN,
          fy,
          {
            width: CONTENT_W - 74,
          },
        );
        fy += 9;
        if (template.signatoryName) {
          text(
            `Authorized Signatory: ${template.signatoryName}${template.signatoryDesignation ? ` (${template.signatoryDesignation})` : ''}`,
            MARGIN,
            fy,
            { width: CONTENT_W - 74 },
          );
          fy += 9;
        }
        doc.font(fonts.oblique).fontSize(6.3).fillColor(INK_400);
        text(
          'This is a computer-generated payslip and does not require a physical signature.',
          MARGIN,
          fy,
          { width: CONTENT_W - 74, lineBreak: true },
        );
        fy = doc.y + 2;
        if (template.footerText) {
          text(template.footerText, MARGIN, fy, {
            width: CONTENT_W - 74,
            lineBreak: true,
          });
        }

        if (qrBuffer) {
          try {
            doc.image(qrBuffer, PAGE_W - MARGIN - 56, footerY + 6, {
              fit: [56, 56],
            });
          } catch {
            /* malformed buffer, skip */
          }
        }
      }

      doc.end();
    });

    return {
      buffer,
      filename: `payslip-${run.employee.employeeId}-${run.month}-${run.year}.pdf`,
    };
  }

  private async getActiveTemplate(organizationId: string) {
    let template = await this.scopedPrisma.payrollTemplate.findFirst({
      where: { organizationId, isDefault: true },
    });
    if (!template) {
      template = await this.scopedPrisma.payrollTemplate.findFirst({
        where: { organizationId },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (!template) {
      template = await this.scopedPrisma.payrollTemplate.create({
        data: { organizationId, name: 'Default Template', isDefault: true },
      });
    }
    return template;
  }

  // Reads already-persisted, already-calculated PayrollRun rows for this
  // employee's financial year up to (and including) the current run, and
  // sums them — a read-time aggregation only. It does not recompute or
  // alter anything the payroll engine produced.
  private async computeYtdTotals(
    employeeId: string,
    financialYear: string,
    currentMonth: number,
    currentYear: number,
    organizationId: string,
  ): Promise<YtdTotals | null> {
    const currentIdx = currentYear * 12 + currentMonth;
    const rows = await this.scopedPrisma.payrollRun.findMany({
      where: {
        organizationId,
        employeeId,
        financialYear,
        isFinalSettlement: false,
        status: {
          in: [
            PayrollRunStatus.APPROVED,
            PayrollRunStatus.LOCKED,
            PayrollRunStatus.PAID,
          ],
        },
      },
      select: {
        month: true,
        year: true,
        grossSalary: true,
        totalDeductions: true,
        netPay: true,
        earnings: true,
        deductions: true,
      },
    });

    const relevant = rows.filter((r) => r.year * 12 + r.month <= currentIdx);
    if (relevant.length === 0) return null;

    const totals: YtdTotals = {
      grossSalary: 0,
      totalDeductions: 0,
      netPay: 0,
      earningsByCode: {},
      deductionsByCode: {},
    };
    for (const r of relevant) {
      totals.grossSalary += Number(r.grossSalary) || 0;
      totals.totalDeductions += Number(r.totalDeductions) || 0;
      totals.netPay += Number(r.netPay) || 0;
      const earningLines = r.earnings as unknown as PayrollLine[];
      const deductionLines = r.deductions as unknown as PayrollLine[];
      for (const e of earningLines) {
        totals.earningsByCode[e.code] =
          (totals.earningsByCode[e.code] || 0) + (Number(e.amount) || 0);
      }
      for (const d of deductionLines) {
        totals.deductionsByCode[d.code] =
          (totals.deductionsByCode[d.code] || 0) + (Number(d.amount) || 0);
      }
    }
    return totals;
  }

  // Fixed-height, two-per-row label/value grid (Employee Details card).
  private drawTwoColKV(
    doc: PDFKit.PDFDocument,
    text: (
      str: string | number | null | undefined,
      x: number,
      y: number,
      opts?: PDFKit.Mixins.TextOptions,
    ) => unknown,
    pairs: [string, string][],
    x: number,
    y: number,
    w: number,
    fonts: { regular: string; bold: string },
  ) {
    const colW = w / 2;
    const rowH = 15;
    let cy = y;
    const draw = ([label, value]: [string, string], px: number) => {
      doc.font(fonts.bold).fontSize(6.3).fillColor(INK_400);
      text(String(label).toUpperCase(), px, cy, { width: colW - 6 });
      doc.font(fonts.regular).fontSize(7.3).fillColor(INK_900);
      text(this.fitText(doc, value, colW - 6), px, cy + 7, { width: colW - 6 });
    };
    for (let i = 0; i < pairs.length; i += 2) {
      draw(pairs[i], x);
      if (pairs[i + 1]) draw(pairs[i + 1], x + colW);
      cy += rowH;
    }
  }

  // Fixed-height, single-column label/value list (Attendance Summary card).
  private drawOneColKV(
    doc: PDFKit.PDFDocument,
    text: (
      str: string | number | null | undefined,
      x: number,
      y: number,
      opts?: PDFKit.Mixins.TextOptions,
    ) => unknown,
    pairs: [string, string | number][],
    x: number,
    y: number,
    w: number,
    fonts: { regular: string; bold: string },
  ) {
    const rowH = 12;
    let cy = y;
    for (const [label, value] of pairs) {
      doc.font(fonts.regular).fontSize(7).fillColor(INK_600);
      text(label, x, cy, { width: w * 0.6 });
      doc.font(fonts.bold).fontSize(7).fillColor(INK_900);
      text(value, x + w * 0.58, cy, { width: w * 0.42, align: 'right' });
      cy += rowH;
    }
  }

  // Earnings/Deductions ledger — Component / Amount / (optional) YTD
  // columns, dynamic row count, plus a bold total row. Returns the y
  // position just below the table so the caller can align the taller of
  // the two side-by-side tables.
  private drawLedgerTable(
    doc: PDFKit.PDFDocument,
    text: (
      str: string | number | null | undefined,
      x: number,
      y: number,
      opts?: PDFKit.Mixins.TextOptions,
    ) => unknown,
    opts: {
      title: string;
      x: number;
      y: number;
      width: number;
      rows: PayrollLine[];
      color: string;
      totalLabel: string;
      totalValue: number;
      ytdMap?: Record<string, number>;
      ytdTotal?: number;
      showYtd: boolean;
      nameColW: number;
      amtColW: number;
      ytdColW: number;
      rowH: number;
      fontSize: number;
      fonts: { regular: string; bold: string };
      money: (n: number | null | undefined) => string;
    },
  ): number {
    const {
      title,
      x,
      y,
      width,
      rows,
      color,
      totalLabel,
      totalValue,
      ytdMap,
      ytdTotal,
      showYtd,
      nameColW,
      amtColW,
      ytdColW,
      rowH,
      fontSize,
      fonts,
      money,
    } = opts;

    doc.font(fonts.bold).fontSize(9).fillColor(color);
    text(title, x, y, { width });
    let ry = y + 15;
    doc.font(fonts.bold).fontSize(6.3).fillColor(INK_400);
    text('COMPONENT', x, ry, { width: nameColW });
    text('AMOUNT', x + nameColW, ry, { width: amtColW, align: 'right' });
    if (showYtd)
      text('YTD', x + nameColW + amtColW, ry, {
        width: ytdColW,
        align: 'right',
      });
    ry += 10;
    doc
      .moveTo(x, ry)
      .lineTo(x + width, ry)
      .strokeColor('#eef0f4')
      .stroke();
    ry += 4;

    if (rows.length === 0) {
      doc.font(fonts.regular).fontSize(fontSize).fillColor(INK_400);
      text('No components configured', x, ry, { width });
      ry += rowH;
    }
    for (const r of rows) {
      doc.font(fonts.regular).fontSize(fontSize).fillColor(INK_900);
      text(this.fitText(doc, r.name, nameColW), x, ry, { width: nameColW });
      text(money(r.amount), x + nameColW, ry, {
        width: amtColW,
        align: 'right',
      });
      if (showYtd) {
        const ytdVal = ytdMap ? ytdMap[r.code] : null;
        doc.fillColor(INK_600);
        text(ytdVal != null ? money(ytdVal) : '-', x + nameColW + amtColW, ry, {
          width: ytdColW,
          align: 'right',
        });
      }
      ry += rowH;
    }

    doc
      .moveTo(x, ry)
      .lineTo(x + width, ry)
      .strokeColor(BORDER)
      .stroke();
    ry += 5;
    doc.font(fonts.bold).fontSize(8.3).fillColor(INK_900);
    text(totalLabel, x, ry, { width: nameColW });
    text(money(totalValue), x + nameColW, ry, {
      width: amtColW,
      align: 'right',
    });
    if (showYtd) {
      doc.fontSize(7.3).fillColor(INK_600);
      text(
        ytdTotal != null ? money(ytdTotal) : '-',
        x + nameColW + amtColW,
        ry,
        { width: ytdColW, align: 'right' },
      );
    }
    return ry + rowH;
  }

  // pdfkit's built-in `ellipsis` option is unreliable combined with
  // `lineBreak: false` — measuring and trimming manually with
  // doc.widthOfString() guarantees single-line output regardless. Must be
  // called with the font/fontSize already set on `doc` for this text.
  private fitText(
    doc: PDFKit.PDFDocument,
    str: string | number | null | undefined,
    maxWidth: number,
  ): string {
    const s = String(str ?? '');
    if (doc.widthOfString(s) <= maxWidth) return s;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (doc.widthOfString(`${s.slice(0, mid)}…`) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? `${s.slice(0, lo)}…` : '…';
  }
}
