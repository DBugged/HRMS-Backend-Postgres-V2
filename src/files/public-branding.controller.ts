// Purpose: Durable, unauthenticated, non-expiring URL for an organisation's Email Logo, used in outgoing emails.
// Important: @Public() by necessity (mail clients fetch <img> anonymously, possibly weeks later). Exposes ONLY the
//   org's stored emailLogoUrl file, ONLY if it is a raster image (png/jpg/jpeg/gif); anything else is a generic 404.
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ApiTags } from '@nestjs/swagger';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { UPLOAD_ROOT, fileStorageDriver } from './file-storage.config';
import { getS3Bucket, getS3Client } from './s3-client';
import { isKeyAllowedForOrg } from './file-token';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
};

@ApiTags('public-branding')
@Controller('public/branding')
export class PublicBrandingController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':organizationId/email-logo')
  @Public()
  async emailLogo(
    @Param(
      'organizationId',
      new ParseUUIDPipe({
        exceptionFactory: () => new NotFoundException(),
      }),
    )
    organizationId: string,
    @Res() res: Response,
  ) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { emailLogoUrl: true },
    });
    const key = org?.emailLogoUrl;
    if (!key || !isKeyAllowedForOrg(organizationId, key)) {
      throw new NotFoundException();
    }
    const contentType = MIME[path.extname(key).toLowerCase()];
    if (!contentType) throw new NotFoundException();

    const setHeaders = () => {
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('Content-Disposition', 'inline');
    };

    if (fileStorageDriver() === 's3') {
      try {
        const object = await getS3Client().send(
          new GetObjectCommand({ Bucket: getS3Bucket(), Key: key }),
        );
        setHeaders();
        (object.Body as NodeJS.ReadableStream).pipe(res);
      } catch {
        throw new NotFoundException();
      }
      return;
    }
    const filePath = path.join(UPLOAD_ROOT, key);
    if (
      !filePath.startsWith(UPLOAD_ROOT + path.sep) ||
      !fs.existsSync(filePath)
    ) {
      throw new NotFoundException();
    }
    setHeaders();
    res.sendFile(filePath);
  }
}
