// Purpose: Turns a raw Multer upload into a stored relativeKey plus a signed, time-limited download URL.
// Responsibilities: Owns only describeUpload() — actual disk/storage placement is relativeKeyFor's job,
// and URL signing is file-token's; this is the thin glue between the two for the upload response shape.
import { BadRequestException, Injectable } from '@nestjs/common';
import * as fs from 'fs';
import { relativeKeyFor } from './file-storage.config';
import { signFileToken } from './file-token';
import { contentMatchesDeclaredType } from './file-signature';

@Injectable()
export class FilesService {
  describeUpload(
    file: Express.Multer.File | undefined,
    category: string,
    organizationId: string,
  ) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    // multer has already written the file. Check its real bytes against the type the client declared; on a
    // mismatch (HTML/script labelled image/png, an empty or truncated file) delete it and refuse. Disk driver
    // only — the S3 engine never has a local path — where the extension allow-list still applies.
    if (file.path) {
      const head = Buffer.alloc(16);
      const fd = fs.openSync(file.path, 'r');
      let read = 0;
      try {
        read = fs.readSync(fd, head, 0, 16, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (!contentMatchesDeclaredType(head.subarray(0, read), file.mimetype)) {
        fs.rmSync(file.path, { force: true });
        throw new BadRequestException(
          'The file is empty or its contents do not match its type.',
        );
      }
    }
    const relativeKey = relativeKeyFor(organizationId, category, file);
    return {
      relativeKey,
      url: `/files/${signFileToken(organizationId, relativeKey)}`,
    };
  }
}
