import * as fs from 'fs';
import * as path from 'path';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { UPLOAD_ROOT, fileStorageDriver } from './file-storage.config';
import { getS3Bucket, getS3Client } from './s3-client';

// Best-effort delete of a stored relativeKey, routed to whichever driver
// is active — a missing/already-gone file shouldn't block deleting the DB
// record that referenced it, same as the fire-and-forget fs.unlink this
// replaced. The one caller of this (documents.service.ts's deletePolicy)
// already guards against relativeKey being an external URL before calling
// this at all.
export function deleteStoredFile(relativeKey: string): void {
  if (fileStorageDriver() === 's3') {
    getS3Client()
      .send(
        new DeleteObjectCommand({ Bucket: getS3Bucket(), Key: relativeKey }),
      )
      .catch(() => {});
    return;
  }

  const localPath = path.join(UPLOAD_ROOT, relativeKey);
  if (!localPath.startsWith(UPLOAD_ROOT + path.sep)) return;
  fs.unlink(localPath, () => {});
}
