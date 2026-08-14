import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { diskStorage } from 'multer';
import type { Request } from 'express';

// Local-disk storage for uploads, namespaced per tenant:
// uploads/{organizationId}/{category}/{uuid.ext}. Every upload route sits
// behind the global JwtAuthGuard, so req.user is always available by the
// time multer's destination callback runs. Files are never served
// directly (no express.static mount) — only through the signed,
// short-lived tokens in file-token.ts, which is what makes namespacing by
// org meaningful as an access boundary rather than just tidier storage.
export const UPLOAD_ROOT = path.join(__dirname, '../../uploads');

export interface FileCategoryConfig {
  allowedMimePrefixes: string[];
  maxSizeBytes: number;
  defaultExt?: string;
}

// Same categories/limits as the old system's middleware/upload.js.
export const FILE_CATEGORIES: Record<string, FileCategoryConfig> = {
  documents: {
    allowedMimePrefixes: ['application/pdf', 'image/', 'video/'],
    maxSizeBytes: 15 * 1024 * 1024, // receipts/PAN cards/policy PDFs, not video
  },
  selfies: {
    allowedMimePrefixes: ['image/'],
    maxSizeBytes: 10 * 1024 * 1024,
    defaultExt: '.jpg',
  },
  branding: {
    allowedMimePrefixes: ['image/'],
    maxSizeBytes: 5 * 1024 * 1024, // a logo, not a photo
    defaultExt: '.png',
  },
  'profile-photos': {
    allowedMimePrefixes: ['image/'],
    maxSizeBytes: 5 * 1024 * 1024,
    defaultExt: '.jpg',
  },
};

interface RequestWithUser extends Request {
  user?: { organizationId: string };
}

export function makeStorage(category: string) {
  const config = FILE_CATEGORIES[category];
  return diskStorage({
    destination: (req: RequestWithUser, _file, cb) => {
      const organizationId = req.user?.organizationId;
      if (!organizationId) {
        cb(new Error('Not authenticated.'), '');
        return;
      }
      const dir = path.join(UPLOAD_ROOT, organizationId, category);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname) || config?.defaultExt || '';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  });
}

// Storage key stored in the DB (durable, org-scoped, never a signed URL) —
// relative to UPLOAD_ROOT, so it survives the file being re-signed on
// every API response.
export function relativeKeyFor(
  organizationId: string,
  category: string,
  file: Express.Multer.File,
): string {
  return `${organizationId}/${category}/${file.filename}`;
}
