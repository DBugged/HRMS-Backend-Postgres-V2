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
