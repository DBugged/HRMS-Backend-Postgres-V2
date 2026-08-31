// Purpose: Shared formal-letter PDF layout — one renderer for all 7 LetterTypes (Offer/Appointment/
//   Relieving/Experience Letter/Experience Certificate/Salary Certificate/Full & Final Settlement), same
//   "one universal layout, only the data varies" approach payslip-pdf.service.ts already uses for payslips.
// Responsibilities: Letterhead (logo/company name/address), Ref No + Date, title, addressee block, body
//   paragraphs, and a signature block (from the org's primary Authorized Signatory, if set).
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import PDFDocument from 'pdfkit';
import { formatDateDisplay } from '../payroll/format-date';
import type { LetterContent } from './letter-content';

const PAGE_W = 595.28; // A4 portrait, points
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;

// backend-v2/assets/fonts lives outside src/, so it isn't copied into
// dist/ by the Nest build the way in-src files are — __dirname's usual
// "two levels up" from a compiled src/<module>/*.js file lands on
// dist/assets/fonts, which doesn't exist (same gap payslip-pdf.service.ts's
// FONTS_DIR has, just never hit there because its default payslip font is
// plain Helvetica). Resolved against a few real candidate roots instead of
// assuming one fixed __dirname depth, so this works the same whether
// running compiled (dist/src/letters) or via ts-node directly (src/letters).
function resolveFontsDir(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'fonts'),
    path.join(__dirname, '..', '..', '..', 'assets', 'fonts'),
    path.join(process.cwd(), 'assets', 'fonts'),
  ];
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
}
const FONTS_DIR = resolveFontsDir();

// Roboto, not pdfkit's standard Helvetica — Helvetica's WinAnsi encoding
// has no ₹ (Indian Rupee) glyph at all (Salary Certificate/Full & Final
// Settlement both print currency amounts), same reasoning and same
// bundled font files payslip-pdf.service.ts already uses.
function registerFonts(doc: PDFKit.PDFDocument): void {
  doc.registerFont(
    'Letter-Regular',
    path.join(FONTS_DIR, 'Roboto-Regular.woff'),
  );
  doc.registerFont('Letter-Bold', path.join(FONTS_DIR, 'Roboto-Bold.woff'));
}

const INK_900 = '#14161d';
const INK_600 = '#4c5262';
const INK_400 = '#98a1b3';
const BORDER = '#dfe2e8';

export interface LetterPdfInput {
  content: LetterContent;
  documentNumber: string;
  issueDate: Date;
  companyName: string;
  companyAddress: string;
  companyLogoBuffer: Buffer | null;
  // true (Offer/Appointment/Relieving/FnF — body opens "Dear X,") renders a
  // "To," addressee block above the body; false (Experience Letter/
  // Certificate, Salary Certificate — body opens "This is to certify...")
  // renders "To Whomsoever It May Concern" instead, since those documents
  // are inherently generic (fine for the employee to carry to any third
  // party), not addressed to the employee as a recipient.
  addressedToEmployee: boolean;
  employeeName: string;
  employeeIdLabel: string;
  signatoryName: string | null;
  signatoryDesignation: string | null;
  signatureBuffer: Buffer | null;
}

@Injectable()
export class LetterPdfService {
  render(input: LetterPdfInput): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ margin: MARGIN, size: 'A4' });
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      registerFonts(doc);

      // Letterhead
      let headerY = 40;
      const logoSize = 40;
      if (input.companyLogoBuffer) {
        try {
          doc.image(input.companyLogoBuffer, MARGIN, headerY, {
            fit: [logoSize, logoSize],
          });
        } catch {
          // Unsupported image format (e.g. an SVG company logo) — continue without it.
        }
      }
      const textX = input.companyLogoBuffer ? MARGIN + logoSize + 12 : MARGIN;
      doc.font('Letter-Bold').fontSize(14).fillColor(INK_900);
      doc.text(input.companyName, textX, headerY, {
        width: CONTENT_W - (textX - MARGIN),
      });
      if (input.companyAddress) {
        doc.font('Letter-Regular').fontSize(8.5).fillColor(INK_600);
        doc.text(input.companyAddress, textX, doc.y + 2, {
          width: CONTENT_W - (textX - MARGIN),
        });
      }
      headerY = Math.max(doc.y, headerY + logoSize) + 14;

      doc
        .moveTo(MARGIN, headerY)
        .lineTo(MARGIN + CONTENT_W, headerY)
        .strokeColor(BORDER)
        .stroke();
      headerY += 20;

      // Ref No / Date, right-aligned
      doc.font('Letter-Regular').fontSize(9).fillColor(INK_600);
      doc.text(`Ref No: ${input.documentNumber}`, MARGIN, headerY, {
        width: CONTENT_W,
        align: 'right',
      });
      doc.text(
        `Date: ${formatDateDisplay(input.issueDate)}`,
        MARGIN,
        doc.y + 2,
        { width: CONTENT_W, align: 'right' },
      );

      // Title
      doc.moveDown(1.5);
      doc.font('Letter-Bold').fontSize(15).fillColor(INK_900);
      doc.text(input.content.title, MARGIN, doc.y, {
        width: CONTENT_W,
        align: 'center',
      });
      doc.moveDown(1.2);

      // Addressee
      doc.font('Letter-Regular').fontSize(10.5).fillColor(INK_900);
      if (input.addressedToEmployee) {
        doc.text('To,', MARGIN, doc.y, { width: CONTENT_W });
        doc
          .font('Letter-Bold')
          .text(input.employeeName, MARGIN, doc.y, { width: CONTENT_W });
        doc.font('Letter-Regular').fontSize(9).fillColor(INK_600);
        doc.text(input.employeeIdLabel, MARGIN, doc.y, { width: CONTENT_W });
        doc.moveDown(1);
      } else {
        doc.font('Letter-Bold').fontSize(10.5);
        doc.text('To Whomsoever It May Concern', MARGIN, doc.y, {
          width: CONTENT_W,
          align: 'center',
        });
        doc.moveDown(1);
      }

      // Body
      doc.font('Letter-Regular').fontSize(10.5).fillColor(INK_900);
      input.content.paragraphs.forEach((p) => {
        doc.text(p, MARGIN, doc.y, {
          width: CONTENT_W,
          align: 'left',
          lineGap: 3,
        });
        doc.moveDown(0.8);
      });

      // Signature block — only when the org has an Authorized Signatory
      // set; otherwise the letter still stands (a document number +
      // letterhead is still a real, traceable document), it just has no
      // signature image.
      doc.moveDown(1.5);
      if (doc.y > doc.page.height - 160) doc.addPage();
      doc.font('Letter-Regular').fontSize(10.5).fillColor(INK_900);
      doc.text(`For ${input.companyName},`, MARGIN, doc.y, {
        width: CONTENT_W,
      });
      doc.moveDown(0.5);
      if (input.signatureBuffer) {
        try {
          doc.image(input.signatureBuffer, MARGIN, doc.y, { fit: [110, 40] });
          doc.moveDown(2.6);
        } catch {
          doc.moveDown(2.6);
        }
      } else {
        doc.moveDown(2.6);
      }
      if (input.signatoryName) {
        doc.font('Letter-Bold').fontSize(10);
        doc.text(input.signatoryName, MARGIN, doc.y, { width: CONTENT_W });
        if (input.signatoryDesignation) {
          doc.font('Letter-Regular').fontSize(9).fillColor(INK_400);
          doc.text(input.signatoryDesignation, MARGIN, doc.y, {
            width: CONTENT_W,
          });
        }
      } else {
        doc.font('Letter-Regular').fontSize(9).fillColor(INK_400);
        doc.text('Authorized Signatory', MARGIN, doc.y, { width: CONTENT_W });
      }

      doc.end();
    });
  }
}
