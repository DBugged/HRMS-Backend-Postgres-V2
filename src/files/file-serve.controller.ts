// Purpose: Serves an uploaded file (disk or S3) by a signed, short-lived token instead of an authenticated request.
// Responsibilities: Verifies the token, then streams the file from whichever storage driver is configured.
// Important: @Public() by necessity — <img>/<iframe> tags can't attach a Bearer header, so the HMAC token is the only credential.
import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ApiTags } from '@nestjs/swagger';
import { GetObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import { Public } from '../common/decorators/public.decorator';
import { UPLOAD_ROOT, fileStorageDriver } from './file-storage.config';
import { getS3Bucket, getS3Client } from './s3-client';
import { verifyFileToken } from './file-token';

// Deliberately NOT behind the JwtAuthGuard — an <img src>, a
// <link rel="icon">, or an embedded PDF viewer's <iframe> can't attach a
// Bearer header, so the token itself (signed, tenant-bound, short-lived —
// see file-token.ts) is the only credential a plain resource fetch like
// this can carry.
@ApiTags('files')
@Controller('files')
export class FileServeController {
  @Get(':token')
  @Public()
  async serve(@Param('token') token: string, @Res() res: Response) {
    const claim = verifyFileToken(token);
    if (!claim) {
      throw new NotFoundException('This link is invalid or has expired.');
    }

    if (fileStorageDriver() === 's3') {
      await this.serveFromS3(claim.relativeKey, res);
      return;
    }
    this.serveFromDisk(claim.relativeKey, res);
  }

  private serveFromDisk(relativeKey: string, res: Response) {
    const filePath = path.join(UPLOAD_ROOT, relativeKey);
    // Reject anything that resolves outside the uploads root (path
    // traversal via a tampered/forged relativeKey) — belt-and-suspenders
    // alongside the HMAC signature already covering the token as a whole.
    if (!filePath.startsWith(UPLOAD_ROOT + path.sep)) {
      throw new NotFoundException('Invalid file reference.');
    }
    if (!fs.existsSync(filePath)) {
      throw new NotFoundException('File not found.');
    }
    res.sendFile(filePath);
  }

  private async serveFromS3(relativeKey: string, res: Response) {
    try {
      const object = await getS3Client().send(
        new GetObjectCommand({ Bucket: getS3Bucket(), Key: relativeKey }),
      );
      if (object.ContentType) res.setHeader('Content-Type', object.ContentType);
      // Body is a Node Readable in the Node runtime (not a web
      // ReadableStream/Blob, which the SDK's types also allow for
      // browser/other runtimes) — this controller only ever runs on Node.
      (object.Body as NodeJS.ReadableStream).pipe(res);
    } catch (err) {
      if (err instanceof NoSuchKey) {
        throw new NotFoundException('File not found.');
      }
      throw err;
    }
  }
}
