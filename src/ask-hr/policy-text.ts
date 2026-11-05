// Purpose: reads the text of an uploaded policy PDF once and stores it on the policy (PolicyDocument.contentText), so Ask HR
//   can search it without reading the file on every question.
// Important: contentText '' means "tried, nothing readable" (a scanned PDF); HR can type or paste text for such a policy, for a link
//   or for an image on the policy form, and a typed text is never overwritten by this. Only internally stored PDFs are read - an
//   external link is never fetched (no SSRF surface).
import { Logger } from '@nestjs/common';
import { PDFParse } from 'pdf-parse';
import { readStoredFile } from '../files/file-storage.config';

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;
export const EXTERNAL_URL_RE = /^https?:\/\//i;
const logger = new Logger('PolicyText');

/** The readable text of a stored PDF, or '' when there is none (scanned, too big, unreadable). */
export async function extractPdfText(fileUrl: string): Promise<string> {
  try {
    const buf = await readStoredFile(fileUrl);
    if (!buf || buf.length > MAX_PDF_BYTES) return '';
    const parser = new PDFParse({ data: buf });
    try {
      return (await parser.getText()).text.replace(/^-- \d+ of \d+ --$/gm, '').slice(0, MAX_TEXT_CHARS).trim();
    } finally {
      await parser.destroy();
    }
  } catch (err) {
    logger.warn(`Could not read policy text: ${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}
