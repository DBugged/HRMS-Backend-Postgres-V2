import * as crypto from 'crypto';
import * as path from 'path';
import type { Request } from 'express';
import type { StorageEngine } from 'multer';
import { Upload } from '@aws-sdk/lib-storage';
import { getS3Bucket, getS3Client } from './s3-client';
import type { FileCategoryConfig } from './file-storage.config';

interface RequestWithUser extends Request {
  user?: { organizationId: string };
}

// Mirrors multer's built-in diskStorage exactly in shape (destination +
// filename -> file.filename set on the callback info) so relativeKeyFor()
// in file-storage.config.ts works identically regardless of which driver
// is active — the S3 key IS the relativeKey, same
// "{organizationId}/{category}/{uuid.ext}" format as local disk, just
// streamed straight to the bucket instead of the local filesystem.
// Uses @aws-sdk/lib-storage's Upload (not a plain PutObjectCommand) so a
// large file streams in without buffering the whole thing in memory first,
// and so it transparently handles multipart if a file ever exceeds the
// single-PUT size — neither of which a raw PutObjectCommand gives you.
export function makeS3StorageEngine(
  category: string,
  config: FileCategoryConfig,
): StorageEngine {
  return {
    _handleFile(req: RequestWithUser, file, cb) {
      const organizationId = req.user?.organizationId;
      if (!organizationId) {
        cb(new Error('Not authenticated.'));
        return;
      }
      const ext = path.extname(file.originalname) || config?.defaultExt || '';
      const filename = `${crypto.randomUUID()}${ext}`;
      const key = `${organizationId}/${category}/${filename}`;

      const upload = new Upload({
        client: getS3Client(),
        params: {
          Bucket: getS3Bucket(),
          Key: key,
          Body: file.stream,
          ContentType: file.mimetype,
        },
      });

      upload
        .done()
        .then(() => cb(null, { filename }))
        .catch((err: Error) => cb(err));
    },
    _removeFile(_req, _file, cb) {
      // Nothing calls this today (no upload-failure cleanup path exists
      // for the local driver either — see the identical gap noted on
      // diskStorage's lack of a _removeFile override), kept as a no-op
      // for interface completeness rather than silently missing.
      cb(null);
    },
  };
}
