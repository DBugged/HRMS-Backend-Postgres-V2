import PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import { attachWatermark } from './pdf-watermark';

// A tiny real PNG (1x1 transparent pixel) — enough for pdfkit to actually
// decode and embed, unlike a fake buffer, so this exercises the real
// doc.image() call rather than always hitting the catch branch.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function renderToBuffer(
  build: (doc: PDFKit.PDFDocument) => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    doc.end();
  });
}

describe('attachWatermark', () => {
  it('does nothing when no logo buffer is given', async () => {
    const buffer = await renderToBuffer((doc) => {
      attachWatermark(doc, null);
      doc.text('Hello');
    });
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('draws without throwing for a real, decodable image', async () => {
    const buffer = await renderToBuffer((doc) => {
      attachWatermark(doc, ONE_PX_PNG);
      doc.text('Hello');
    });
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('silently skips an undecodable buffer instead of failing the document', async () => {
    const garbage = Buffer.from('not a real image');
    const buffer = await renderToBuffer((doc) => {
      attachWatermark(doc, garbage);
      doc.text('Still renders');
    });
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('redraws on every added page, not just the first', async () => {
    const buffer = await renderToBuffer((doc) => {
      // Count how many times attachWatermark's own draw() actually calls
      // doc.image() — once per page, including the implicit first one.
      const imageSpy = jest.spyOn(doc, 'image');
      attachWatermark(doc, ONE_PX_PNG);
      doc.addPage();
      doc.addPage();
      expect(imageSpy).toHaveBeenCalledTimes(3);
    });
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('renders a full real letter PDF with a watermark without throwing', async () => {
    // Sanity-checks the actual bundled font path this app ships with, same
    // font letter-pdf.service.ts registers, to catch any interaction
    // between font registration and the watermark's save/restore calls.
    const fontsDir = path.join(__dirname, '..', '..', 'assets', 'fonts');
    const buffer = await renderToBuffer((doc) => {
      if (fs.existsSync(path.join(fontsDir, 'Roboto-Regular.woff'))) {
        doc.registerFont(
          'Letter-Regular',
          path.join(fontsDir, 'Roboto-Regular.woff'),
        );
        doc.font('Letter-Regular');
      }
      attachWatermark(doc, ONE_PX_PNG);
      doc
        .fontSize(12)
        .text('A full paragraph of body text sitting on top of the watermark.');
    });
    expect(buffer.length).toBeGreaterThan(0);
  });
});
