// Purpose: how much file storage a company uses, and removing all of it when the company is deleted.
// Important: uploads live under "<organizationId>/..." on both drivers (local disk or S3), so a company's files are exactly
//   that folder/prefix. The id is checked to look like a UUID-style id before it is used in a path or prefix.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { UPLOAD_ROOT, fileStorageDriver } from '../files/file-storage.config';
import { getS3Bucket, getS3Client } from '../files/s3-client';

const SAFE_ID = /^[A-Za-z0-9-]{6,64}$/;
const dirOf = (organizationId: string) => path.join(UPLOAD_ROOT, organizationId);

function localSize(dir: string): number {
  let total = 0;
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? localSize(p) : fs.statSync(p).size;
  }
  return total;
}

/** Bytes stored for the company; null when it cannot be read (the panel shows "unknown"). */
export async function storageBytes(organizationId: string): Promise<number | null> {
  if (!SAFE_ID.test(organizationId)) return null;
  try {
    if (fileStorageDriver() !== 's3') return localSize(dirOf(organizationId));
    let total = 0;
    let token: string | undefined;
    do {
      const r = await getS3Client().send(new ListObjectsV2Command({ Bucket: getS3Bucket(), Prefix: `${organizationId}/`, ContinuationToken: token }));
      total += (r.Contents ?? []).reduce((n, o) => n + (o.Size ?? 0), 0);
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return total;
  } catch {
    return null;
  }
}

/** Deletes every stored file of the company. Returns how many were removed (best effort: never throws). */
export async function removeAllFiles(organizationId: string): Promise<number> {
  if (!SAFE_ID.test(organizationId)) return 0;
  try {
    if (fileStorageDriver() !== 's3') {
      const dir = dirOf(organizationId);
      if (!dir.startsWith(UPLOAD_ROOT + path.sep) || !fs.existsSync(dir)) return 0;
      fs.rmSync(dir, { recursive: true, force: true });
      return 1;
    }
    let removed = 0;
    let token: string | undefined;
    do {
      const r = await getS3Client().send(new ListObjectsV2Command({ Bucket: getS3Bucket(), Prefix: `${organizationId}/`, ContinuationToken: token }));
      const keys = (r.Contents ?? []).map((o) => ({ Key: o.Key! }));
      if (keys.length) {
        await getS3Client().send(new DeleteObjectsCommand({ Bucket: getS3Bucket(), Delete: { Objects: keys, Quiet: true } }));
        removed += keys.length;
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return removed;
  } catch {
    return 0;
  }
}
