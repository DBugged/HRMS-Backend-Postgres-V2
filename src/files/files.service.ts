// Purpose: Turns a raw Multer upload into a stored relativeKey plus a signed, time-limited download URL.
// Responsibilities: Owns only describeUpload() — actual disk/storage placement is relativeKeyFor's job,
// and URL signing is file-token's; this is the thin glue between the two for the upload response shape.
import { BadRequestException, Injectable } from '@nestjs/common';
import { relativeKeyFor } from './file-storage.config';
import { signFileToken } from './file-token';

@Injectable()
export class FilesService {
  describeUpload(
    file: Express.Multer.File | undefined,
    category: string,
    organizationId: string,
  ) {
    if (!file) throw new BadRequestException('No file was uploaded.');
    const relativeKey = relativeKeyFor(organizationId, category, file);
    return {
      relativeKey,
      url: `/files/${signFileToken(organizationId, relativeKey)}`,
    };
  }
}
