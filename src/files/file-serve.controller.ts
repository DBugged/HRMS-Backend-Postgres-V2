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
import { isKeyAllowedForOrg, verifyFileToken } from './file-token';
import { INLINE_SAFE_EXTENSIONS } from './file-signature';

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
    // The token's organizationId must agree with the key it points at (no cross-tenant or traversal keys).
    if (!isKeyAllowedForOrg(claim.organizationId, claim.relativeKey)) {
      throw new NotFoundException('Invalid file reference.');
    }

    // helmet's default X-Frame-Options: SAMEORIGIN (set in main.ts) blocks
    // the browser from rendering this response inside an <iframe> at all
    // whenever the frontend is on a different origin — the normal case (a
    // different port in dev, a different subdomain in prod) — which broke
    // every in-app PDF/document viewer (FileViewerModal, Documents.tsx's
    // policy-document viewer) with a silently blank iframe, no console
    // error. Same rationale as crossOriginResourcePolicy above: access is
    // already controlled by the signed, short-lived token in the URL, so
    // frame-embedding protection isn't adding real protection here, only
    // breaking a legitimate same-app cross-origin embed.
    res.removeHeader('X-Frame-Options');

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
    // Explicit inline Content-Disposition — without it, some browsers (seen
    // with Safari/WKWebView) fall back to an OS "Save As" prompt for a PDF
    // instead of rendering it, and since the token in the URL carries no
    // file extension, that prompt suggests the raw signed token itself as
    // the filename. The stored key (a generated UUID + real extension, not
    // the original upload's fileName — that lives only in the DB row this
    // controller never sees) at least gives a sane, correctly-extensioned
    // suggested name either way.
    // Only known-safe types (PDF, raster images, video) may render inline. Anything else — including files
    // stored before the upload allow-list existed (.html, .svg...) — is forced to download as an opaque blob, so
    // an uploaded document can never execute script on this origin.
    const inlineSafe = INLINE_SAFE_EXTENSIONS.has(
      path.extname(filePath).toLowerCase(),
    );
    if (!inlineSafe) res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${inlineSafe ? 'inline' : 'attachment'}; filename="${path.basename(filePath)}"`,
    );
    res.sendFile(filePath);
  }

  private async serveFromS3(relativeKey: string, res: Response) {
    try {
      const object = await getS3Client().send(
        new GetObjectCommand({ Bucket: getS3Bucket(), Key: relativeKey }),
      );
      // Same policy as the disk path: only known-safe extensions render inline; everything else is an opaque
      // download, and nosniff is always set.
      const inlineSafe = INLINE_SAFE_EXTENSIONS.has(
        path.extname(relativeKey).toLowerCase(),
      );
      if (inlineSafe && object.ContentType) {
        res.setHeader('Content-Type', object.ContentType);
      } else if (!inlineSafe) {
        res.setHeader('Content-Type', 'application/octet-stream');
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Disposition',
        `${inlineSafe ? 'inline' : 'attachment'}; filename="${path.basename(relativeKey)}"`,
      );
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
