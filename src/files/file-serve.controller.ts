import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { UPLOAD_ROOT } from './file-storage.config';
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
  serve(@Param('token') token: string, @Res() res: Response) {
    const claim = verifyFileToken(token);
    if (!claim) {
      throw new NotFoundException('This link is invalid or has expired.');
    }

    const filePath = path.join(UPLOAD_ROOT, claim.relativeKey);
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
}
