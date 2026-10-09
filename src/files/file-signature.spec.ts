import {
  ALLOWED_MIME_TYPES,
  contentMatchesDeclaredType,
  describeAllowedTypes,
  hasAllowedExtension,
  INLINE_SAFE_EXTENSIONS,
  inlineContentType,
  matchesJpegOrPng,
  sniffKind,
  sniffRasterFormat,
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

describe('branding is JPEG and PNG only', () => {
  const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex');
  const gif = Buffer.from('474946383961', 'hex');
  const webp = Buffer.concat([
    Buffer.from('RIFF....', 'ascii'),
    Buffer.from('WEBPVP8 ', 'ascii'),
  ]);

  it('allows only .png/.jpg/.jpeg for branding, rejecting every other image type and SVG', () => {
    for (const n of ['logo.png', 'logo.JPG', 'logo.jpeg']) {
      expect(hasAllowedExtension('branding', n)).toBe(true);
    }
    for (const n of [
      'logo.svg',
      'logo.webp',
      'logo.gif',
      'logo.bmp',
      'logo.heic',
      'logo.avif',
    ]) {
      expect(hasAllowedExtension('branding', n)).toBe(false);
    }
    expect(ALLOWED_MIME_TYPES.branding).toEqual(['image/png', 'image/jpeg']);
  });
  it('applies the same JPEG/PNG-only rule to profile photos, but not to selfies or documents', () => {
    expect(hasAllowedExtension('profile-photos', 'me.jpg')).toBe(true);
    expect(hasAllowedExtension('profile-photos', 'me.webp')).toBe(false);
    expect(hasAllowedExtension('profile-photos', 'me.svg')).toBe(false);
    expect(ALLOWED_MIME_TYPES['profile-photos']).toEqual([
      'image/png',
      'image/jpeg',
    ]);
    expect(hasAllowedExtension('selfies', 'me.heic')).toBe(true);
    expect(hasAllowedExtension('documents', 'scan.webp')).toBe(true);
  });
  it('recognises only PNG and JPEG bytes', () => {
    expect(sniffRasterFormat(png)).toBe('png');
    expect(sniffRasterFormat(jpeg)).toBe('jpeg');
    expect(sniffRasterFormat(gif)).toBeNull();
    expect(sniffRasterFormat(webp)).toBeNull();
    expect(sniffRasterFormat(html)).toBeNull();
  });
  it('requires bytes, MIME type and extension to agree', () => {
    expect(matchesJpegOrPng(png, 'a.png', 'image/png')).toBe(true);
    expect(matchesJpegOrPng(jpeg, 'a.jpg', 'image/jpeg')).toBe(true);
    expect(matchesJpegOrPng(jpeg, 'a.jpeg', 'image/jpeg')).toBe(true);
    expect(matchesJpegOrPng(gif, 'a.png', 'image/png')).toBe(false); // GIF renamed
    expect(matchesJpegOrPng(jpeg, 'a.png', 'image/png')).toBe(false); // JPEG labelled PNG
    expect(matchesJpegOrPng(png, 'a.png', 'image/jpeg')).toBe(false); // wrong MIME
    expect(matchesJpegOrPng(png, 'a.jpg', 'image/png')).toBe(false); // wrong extension
  });
  it('describes the accepted types for the error message', () => {
    expect(describeAllowedTypes('branding', ['image/'])).toBe(
      'JPEG and PNG images (.png, .jpg, .jpeg)',
    );
    expect(describeAllowedTypes('selfies', ['image/'])).toContain(
      'image files',
    );
  });
  it('derives the inline Content-Type from the extension, case-insensitively', () => {
    expect(inlineContentType('.pdf')).toBe('application/pdf');
    expect(inlineContentType('.PDF')).toBe('application/pdf');
    expect(inlineContentType('.jpg')).toBe('image/jpeg');
    expect(inlineContentType('.mp4')).toBe('video/mp4');
  });
  it('has no inline Content-Type for types that must download', () => {
    expect(inlineContentType('.html')).toBeUndefined();
    expect(inlineContentType('.svg')).toBeUndefined();
    expect(inlineContentType('')).toBeUndefined();
  });
  it('covers every inline-safe extension', () => {
    for (const ext of INLINE_SAFE_EXTENSIONS) {
      expect(inlineContentType(ext)).toBeDefined();
    }
  });
});

import { contentMatchesExtension } from './file-signature';
describe('contentMatchesExtension', () => {
  it('rejects an executable named .pdf', () => {
    expect(
      contentMatchesExtension(Buffer.from('MZ\x90\x00\x03'), 'a.pdf'),
    ).toBe(false);
  });
  it('accepts real PDF bytes', () => {
    expect(contentMatchesExtension(Buffer.from('%PDF-1.7'), 'a.PDF')).toBe(
      true,
    );
  });
});
