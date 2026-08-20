import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { diskStorage } from 'multer';
import type { Request } from 'express';
import { makeS3StorageEngine } from './s3-storage-engine';

// Defaults to local disk — dev/test never sets this, so nothing about
// the existing workflow (including every e2e test, none of which have
// real AWS credentials) changes unless a deployment explicitly opts in.
export function fileStorageDriver(): 'local' | 's3' {
  return process.env.FILE_STORAGE_DRIVER === 's3' ? 's3' : 'local';
}

// Storage for uploads, namespaced per tenant:
// {organizationId}/{category}/{uuid.ext} — either on local disk (default,
// used by every deployment that doesn't set FILE_STORAGE_DRIVER=s3, and
// always by dev/test) or in an S3 bucket, selected by fileStorageDriver()
// below. Every upload route sits behind the global JwtAuthGuard, so
// req.user is always available by the time the storage engine's
// destination/key-generation logic runs. Files are never served directly
// (no express.static mount, no public-read S3 ACL) — only through the
// signed, short-lived tokens in file-token.ts, which is what makes
// namespacing by org meaningful as an access boundary rather than just
// tidier storage, and what stays byte-for-byte identical across both
// drivers (see file-serve.controller.ts).
// Anchored to process.cwd() rather than __dirname: tsc's outDir preserves
// the src/ prefix inside dist/ (compiled files land at dist/src/files/, one
// level deeper than src/files/), so a __dirname-relative path resolved to a
// different depth depending on whether the process was running compiled
// (dist/src/files/../../uploads → dist/uploads, silently wiped by every
// `nest build`, which has deleteOutDir: true) or via ts-node (src/files/../../uploads
// → the real uploads/ dir). Nest is always started with cwd at the project
// root in every mode (start, start:dev, start:prod, test), so this is stable.
export const UPLOAD_ROOT = path.join(process.cwd(), 'uploads');

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
  if (fileStorageDriver() === 's3') {
    return makeS3StorageEngine(category, config);
  }
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
