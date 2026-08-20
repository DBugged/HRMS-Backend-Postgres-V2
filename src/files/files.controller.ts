// Purpose: Exposes multipart upload endpoints for documents, selfies, branding assets, and profile photos.
// Responsibilities: Validates file type/size per category via multer interceptors and delegates storage to FilesService.
// Important: Any authenticated user may upload — access control lives downstream, in what each domain field does with the returned key.
import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { FILE_CATEGORIES, makeStorage } from './file-storage.config';
import { FilesService } from './files.service';

type Caller = Omit<User, 'password'>;

function categoryInterceptor(category: string) {
  const config = FILE_CATEGORIES[category];
  return FileInterceptor('file', {
    storage: makeStorage(category),
    limits: { fileSize: config.maxSizeBytes },
    fileFilter: (_req, file, cb) => {
      if (config.allowedMimePrefixes.some((p) => file.mimetype.startsWith(p))) {
        cb(null, true);
        return;
      }
      cb(
        new BadRequestException(
          `Only ${config.allowedMimePrefixes.join(', ')} files are allowed for this category.`,
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
