// Purpose: Decides whether an uploaded file really is the kind of file it claims to be.
// Responsibilities: (1) an extension allow-list per upload category, (2) a magic-byte check of the first bytes
//   against the declared MIME family. Pure functions so they're testable without multer or a disk.
// Important: multer's fileFilter only sees the CLIENT-declared mimetype and original name — both trivially
//   spoofed — so an .html/.php/.svg body labelled "image/png" used to be stored with its own extension and later
//   served inline by the file-serve controller. Both checks here run on data the client can't just relabel.
import * as path from 'path';

const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.heic',
  '.heif',
  '.avif',
];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm'];

// Extensions each upload category may store. Deliberately excludes .svg (scriptable), .html, .js and anything
// executable — an image upload is a raster image, nothing else.
export const ALLOWED_EXTENSIONS: Record<string, string[]> = {
  documents: ['.pdf', ...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS],
  selfies: IMAGE_EXTENSIONS,
  // Company logo, favicon, report/email logo, signatures and seal: JPEG and PNG only. Not WEBP/GIF/HEIC (not
  // reliably renderable in emails, PDFs and every browser) and never SVG (scriptable).
  branding: ['.png', '.jpg', '.jpeg'],
  // Profile photos follow the same rule as branding images.
  'profile-photos': ['.png', '.jpg', '.jpeg'],
};

// Categories that also pin the exact MIME types (not just the "image/" family), so the declared type has to agree
// with the extension allow-list above.
export const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  branding: ['image/png', 'image/jpeg'],
  'profile-photos': ['image/png', 'image/jpeg'],
};

// Human-readable list of what a category accepts, used in the upload error message.
export function describeAllowedTypes(
  category: string,
  mimePrefixes: string[],
): string {
  const extensions = (ALLOWED_EXTENSIONS[category] ?? []).join(', ');
  if (ALLOWED_MIME_TYPES[category]) {
    return `JPEG and PNG images (${extensions})`;
  }
  const kinds = mimePrefixes.map((p) =>
    p.startsWith('image/')
      ? 'image'
      : p === 'application/pdf'
        ? 'PDF'
        : p.replace(/\/$/, ''),
  );
  return `${kinds.join(' / ')} files (${extensions})`;
}

// Extensions safe to render inline when a stored file is served back; everything else is forced to download.
export const INLINE_SAFE_EXTENSIONS = new Set([
  '.pdf',
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
]);

export function hasAllowedExtension(
  category: string,
  originalName: string,
): boolean {
  const ext = path.extname(originalName ?? '').toLowerCase();
  return (ALLOWED_EXTENSIONS[category] ?? []).includes(ext);
}

const startsWith = (b: Buffer, hex: string, offset = 0) =>
  b.length >= offset + hex.length / 2 &&
  b.subarray(offset, offset + hex.length / 2).toString('hex') === hex;

// Recognises the container formats the app accepts from the first bytes of a file. Returns 'pdf' | 'image' |
// 'video' or null when the bytes match none of them.
export function sniffKind(head: Buffer): 'pdf' | 'image' | 'video' | null {
  if (startsWith(head, '25504446')) return 'pdf'; // %PDF
  if (
    startsWith(head, '89504e47') || // PNG
    startsWith(head, 'ffd8ff') || // JPEG
    startsWith(head, '47494638') || // GIF
    startsWith(head, '424d') || // BMP
    (startsWith(head, '52494646') &&
      head.subarray(8, 12).toString('ascii') === 'WEBP')
  ) {
    return 'image';
  }
  const brand = head.subarray(4, 12).toString('ascii');
  if (brand.startsWith('ftyp')) {
    // ISO base media: HEIC/HEIF/AVIF stills vs MP4/MOV video, told apart by the major brand.
    return /ftyp(heic|heix|hevc|mif1|msf1|avif|avis)/.test(brand)
      ? 'image'
      : 'video';
  }
  if (startsWith(head, '1a45dfa3')) return 'video'; // WebM / Matroska
  return null;
}

export type RasterFormat = 'png' | 'jpeg';

// Recognises PNG and JPEG from the first bytes; null for anything else (including GIF/WEBP/BMP/HEIC/SVG).
export function sniffRasterFormat(head: Buffer): RasterFormat | null {
  if (startsWith(head, '89504e470d0a1a0a')) return 'png';
  if (startsWith(head, 'ffd8ff')) return 'jpeg';
  return null;
}

// Strict check for the JPEG/PNG-only categories: the real bytes must be PNG or JPEG, and the declared MIME type and
// the file extension must both name that same format — so a GIF or WEBP renamed ".png", or a JPEG sent as
// "image/png", is refused instead of being stored under a misleading type.
export function matchesJpegOrPng(
  head: Buffer,
  originalName: string,
  declaredMime: string,
): boolean {
  const format = sniffRasterFormat(head);
  if (!format) return false;
  const ext = path.extname(originalName ?? '').toLowerCase();
  const extFormat =
    ext === '.png' ? 'png' : ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : null;
  const mimeFormat =
    declaredMime === 'image/png'
      ? 'png'
      : declaredMime === 'image/jpeg'
        ? 'jpeg'
        : null;
  return extFormat === format && mimeFormat === format;
}

// Whether the file's real bytes are consistent with the MIME family the client declared. An empty file is never
// valid.
export function contentMatchesDeclaredType(
  head: Buffer,
  declaredMime: string,
): boolean {
  if (head.length === 0) return false;
  const kind = sniffKind(head);
  if (!kind) return false;
  if (declaredMime === 'application/pdf') return kind === 'pdf';
  if (declaredMime.startsWith('image/')) return kind === 'image';
  if (declaredMime.startsWith('video/')) return kind === 'video';
  return false;
}
