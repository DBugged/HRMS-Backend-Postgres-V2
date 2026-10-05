// Purpose: Turns multer's bare "File too large" (Nest maps LIMIT_FILE_SIZE to a 413 with that text) into a message that
//   says what the limit is, so the person uploading knows what to do about it.
// Important: the limit comes from the same FILE_CATEGORIES table the upload interceptors enforce, keyed by the
//   /files/upload/<category> route, so the message can never disagree with the actual limit.
import { FILE_CATEGORIES } from './file-storage.config';

export const MULTER_FILE_TOO_LARGE = 'File too large';

export function describeFileTooLarge(url: string): string {
  const category = /\/files\/upload\/([a-z-]+)/.exec(url)?.[1];
  const config = category ? FILE_CATEGORIES[category] : undefined;
  if (!config) return 'The file is too large to upload.';
  const mb = Math.round(config.maxSizeBytes / (1024 * 1024));
  return `The file is too large. The maximum size for this upload is ${mb} MB — choose a smaller file.`;
}
