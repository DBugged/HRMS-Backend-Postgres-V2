import {
  contentMatchesDeclaredType,
  hasAllowedExtension,
  sniffKind,
} from './file-signature';

const png = Buffer.from('89504e470d0a1a0a0000000d', 'hex');
const pdf = Buffer.from('%PDF-1.7\n', 'ascii');
const html = Buffer.from('<html><script>alert(1)</script></html>');

describe('hasAllowedExtension', () => {
  it('allows raster images and PDFs where the category permits, case-insensitively', () => {
    expect(hasAllowedExtension('documents', 'Scan.PDF')).toBe(true);
    expect(hasAllowedExtension('documents', 'a.png')).toBe(true);
    expect(hasAllowedExtension('selfies', 'me.jpeg')).toBe(true);
  });
  it('rejects scriptable / executable / unknown extensions', () => {
    for (const n of [
      'x.html',
      'x.svg',
      'x.php',
      'x.js',
      'x.exe',
      'noext',
      'a.png.html',
    ]) {
      expect(hasAllowedExtension('documents', n)).toBe(false);
    }
    expect(hasAllowedExtension('branding', 'doc.pdf')).toBe(false);
  });
});

describe('content sniffing', () => {
  it('recognises the accepted formats', () => {
    expect(sniffKind(png)).toBe('image');
    expect(sniffKind(pdf)).toBe('pdf');
    expect(sniffKind(Buffer.from('000000206674797069736f6d', 'hex'))).toBe(
      'video',
    );
    expect(sniffKind(Buffer.from('0000001c6674797068656963', 'hex'))).toBe(
      'image',
    );
    expect(sniffKind(html)).toBeNull();
  });
  it('rejects a body that does not match the declared type, and empty files', () => {
    expect(contentMatchesDeclaredType(png, 'image/png')).toBe(true);
    expect(contentMatchesDeclaredType(pdf, 'application/pdf')).toBe(true);
    expect(contentMatchesDeclaredType(html, 'image/png')).toBe(false);
    expect(contentMatchesDeclaredType(png, 'application/pdf')).toBe(false);
    expect(
      contentMatchesDeclaredType(Buffer.from('not a pdf'), 'application/pdf'),
    ).toBe(false);
    expect(contentMatchesDeclaredType(Buffer.alloc(0), 'application/pdf')).toBe(
      false,
    );
  });
});
