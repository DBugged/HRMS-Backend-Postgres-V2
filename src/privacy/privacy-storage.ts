// Purpose: Stores a server-generated file (e.g. a data-export JSON) in the same storage the uploads use.
// Responsibilities: Writes under <orgId>/<category>/<uuid>.<ext> on local disk or S3, whichever
// FILE_STORAGE_DRIVER selects, and returns the durable relativeKey (never a URL).
// Important: The key is only ever reachable through a short-lived signed token (signFileToken) — there is no public
// URL. Mirrors relativeKeyFor's key layout so the existing /files/:token route can serve it unchanged.
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { UPLOAD_ROOT, fileStorageDriver } from '../files/file-storage.config';
import { getS3Bucket, getS3Client } from '../files/s3-client';

export async function storeGeneratedFile(
  organizationId: string,
  category: string,
  ext: string,
  content: Buffer,
  contentType: string,
): Promise<string> {
  const relativeKey = `${organizationId}/${category}/${randomUUID()}${ext}`;
  if (fileStorageDriver() === 's3') {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: getS3Bucket(),
        Key: relativeKey,
        Body: content,
        ContentType: contentType,
      }),
    );
    return relativeKey;
  }
  const filePath = path.join(UPLOAD_ROOT, relativeKey);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return relativeKey;
}
