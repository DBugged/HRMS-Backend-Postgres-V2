// Purpose: Exposes multipart upload endpoints for documents, selfies, branding assets, and profile photos.
// Responsibilities: Validates file type/size per category via multer interceptors and delegates storage to FilesService.
// Important: Any authenticated user may upload — access control lives downstream, in what each domain field does with the returned key.
import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { fileKindOf } from './file-signature';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FILE_CATEGORIES, makeStorage } from './file-storage.config';
import { FilesService } from './files.service';
import {
  SESSION_ASSET_TTL_SECONDS,
  isKeyAllowedForOrg,
  signFileToken,
  verifyFileTokenIgnoringExpiry,
} from './file-token';
import {
  ALLOWED_MIME_TYPES,
  describeAllowedTypes,
  hasAllowedExtension,
} from './file-signature';

type Caller = Omit<User, 'password'>;

function categoryInterceptor(category: string) {
  const config = FILE_CATEGORIES[category];
  return FileInterceptor('file', {
    storage: makeStorage(category),
    limits: { fileSize: config.maxSizeBytes },
    fileFilter: (_req, file, cb) => {
      // Both the declared type AND the file's extension must be on the category's allow-list — the extension is
      // what the stored file keeps, and so what it is later served as.
      const exactMimes = ALLOWED_MIME_TYPES[category];
      const mimeOk = exactMimes
        ? exactMimes.includes(file.mimetype)
        : config.allowedMimePrefixes.some((p) => file.mimetype.startsWith(p));
      if (mimeOk && hasAllowedExtension(category, file.originalname)) {
        cb(null, true);
        return;
      }
      cb(
        new BadRequestException(
          `Only ${describeAllowedTypes(category, config.allowedMimePrefixes)} are allowed for this category.`,
        ),
        false,
      );
    },
  });
}

// Any authenticated user may upload — access control lives in what each
// domain field then does with the returned relativeKey (e.g. only ADMIN/HR
// can PUT it onto PayrollTemplate.companyLogoUrl), same as the old system.
@ApiTags('files')
@ApiBearerAuth('access-token')
@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  // A signed file link lives for minutes, but a page keeps the link it loaded with. The client sends back the (possibly
  // expired) link it holds and gets a fresh one for the same file - only for a link that carries this server's own
  // signature, was issued for the caller's own organization, and points at an allowed key.
  @Post('refresh')
  refresh(@CurrentUser() caller: Caller, @Body() body: { url?: unknown }) {
    const raw = typeof body?.url === 'string' ? body.url : '';
    const marker = raw.indexOf('/files/');
    const claim =
      marker >= 0
        ? verifyFileTokenIgnoringExpiry(raw.slice(marker + '/files/'.length))
        : null;
    if (
      !claim ||
      claim.organizationId !== caller.organizationId ||
      !isKeyAllowedForOrg(caller.organizationId, claim.relativeKey)
    ) {
      throw new BadRequestException('This file link cannot be refreshed.');
    }
    const token = signFileToken(
      claim.organizationId,
      claim.relativeKey,
      SESSION_ASSET_TTL_SECONDS,
    );
    return {
      url: `/files/${token}`,
      // Lets a client choose between an image view and a PDF viewer for a link that has no extension.
      kind: fileKindOf(claim.relativeKey),
    };
  }

  @Post('upload/documents')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(categoryInterceptor('documents'))
  uploadDocument(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() caller: Caller,
  ) {
    return this.filesService.describeUpload(
      file,
      'documents',
      caller.organizationId,
    );
  }

  @Post('upload/selfies')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(categoryInterceptor('selfies'))
  uploadSelfie(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() caller: Caller,
  ) {
    return this.filesService.describeUpload(
      file,
      'selfies',
      caller.organizationId,
    );
  }

  @Post('upload/branding')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(categoryInterceptor('branding'))
  uploadBranding(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() caller: Caller,
  ) {
    return this.filesService.describeUpload(
      file,
      'branding',
      caller.organizationId,
    );
  }

  @Post('upload/profile-photos')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(categoryInterceptor('profile-photos'))
  uploadProfilePhoto(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() caller: Caller,
  ) {
    return this.filesService.describeUpload(
      file,
      'profile-photos',
      caller.organizationId,
    );
  }
}
