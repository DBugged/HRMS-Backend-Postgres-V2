import { deflateSync } from 'zlib';
import { LetterPdfService, type LetterPdfInput } from './letter-pdf.service';

// A solid-colour PNG of the given size (no image library needed in tests).
function png(
  width: number,
  height: number,
  rgb: [number, number, number],
): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: width }, () => rgb).flat()),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const base: LetterPdfInput = {
  content: {
    title: 'Appointment Letter',
    paragraphs: ['Dear Asha,', 'We are pleased to offer you the role.'],
  },
  documentNumber: 'APP-0001',
  issueDate: new Date('2026-10-16'),
  companyName: 'Demo Company',
  companyAddress: 'Pune',
  companyLogoBuffer: null,
  addressedToEmployee: true,
  employeeName: 'Asha',
  employeeIdLabel: 'Employee ID: DP-1',
  signatoryName: 'A Person',
  signatoryDesignation: 'Director',
  signatureBuffer: null,
  watermarkEnabled: false,
};

describe('LetterPdfService header / footer images', () => {
  const service = new LetterPdfService();
  const pages = (pdf: Buffer) =>
    (pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
  const images = (pdf: Buffer) =>
    (pdf.toString('latin1').match(/\/Subtype \/Image/g) || []).length;

  it('renders with the built-in header when no image is set', async () => {
    const pdf = await service.render(base);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(images(pdf)).toBe(0);
  });

  it('draws the header and footer images', async () => {
    const pdf = await service.render({
      ...base,
      letterHeaderBuffer: png(60, 10, [200, 220, 255]),
      letterFooterBuffer: png(60, 6, [255, 230, 200]),
    });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(images(pdf)).toBeGreaterThanOrEqual(2);
  });

  it('puts the strips on every page of a long letter', async () => {
    const long = Array.from({ length: 80 }, (_, i) =>
      `Paragraph ${i + 1}. `.repeat(20),
    );
    const pdf = await service.render({
      ...base,
      content: { title: 'Long', paragraphs: long },
      letterHeaderBuffer: png(60, 10, [200, 220, 255]),
      letterFooterBuffer: png(60, 6, [255, 230, 200]),
    });
    expect(pages(pdf)).toBeGreaterThan(1);
  });

  it('ignores an image it cannot read', async () => {
    const pdf = await service.render({
      ...base,
      letterHeaderBuffer: Buffer.from('not an image'),
    });
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
