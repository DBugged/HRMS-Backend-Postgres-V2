// Purpose: Draws a large, faded, centered copy of a logo behind a PDF page's content — the single shared
//   implementation of Organization Settings > Branding > "Watermark this logo on generated documents",
//   used by every PDF generator in the app (letters, payslips, report exports) so it's one behavior, not
//   three independently-drawn ones.
// Responsibilities: attachWatermark() draws once for whatever page already exists on the document (pdfkit
//   never fires its own 'pageAdded' event for the constructor's initial page — a well-known gotcha, not a
//   bug here) and again on every later addPage() call, so a multi-page document stays watermarked
//   throughout without every caller needing to know that. Silently does nothing when no logo is provided,
//   or the image format is one pdfkit can't decode (SVG/WEBP) — a broken watermark must never fail the
//   document it's decorating.
import type PDFKit from 'pdfkit';

// Deliberately faint — this sits behind real content (letter body,
// payslip line items, report rows), not so dark it starts competing with
// it for legibility.
const WATERMARK_OPACITY = 0.06;
// Fraction of the page's shorter dimension the logo's largest side is
// scaled to — large enough to read as a watermark, not so large it runs
// off two edges on both portrait and landscape page sizes.
const WATERMARK_SIZE_RATIO = 0.6;

export function attachWatermark(
  doc: PDFKit.PDFDocument,
  logoBuffer: Buffer | null | undefined,
): void {
  if (!logoBuffer) return;

  const draw = () => {
    const { width, height } = doc.page;
    const size = Math.min(width, height) * WATERMARK_SIZE_RATIO;
    const x = (width - size) / 2;
    const y = (height - size) / 2;
    doc.save();
    doc.opacity(WATERMARK_OPACITY);
    try {
      doc.image(logoBuffer, x, y, {
        fit: [size, size],
        align: 'center',
        valign: 'center',
      });
    } catch {
      // Unsupported image format (e.g. an SVG/WEBP logo) — same
      // best-effort convention every other doc.image() call in this app
      // already follows (letter-pdf.service.ts, payslip-pdf.service.ts,
      // report-export.ts).
    }
    doc.restore();
  };

  draw();
  doc.on('pageAdded', draw);
}
