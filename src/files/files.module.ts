import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FileServeController } from './file-serve.controller';
import { PublicBrandingController } from './public-branding.controller';
import { FilesService } from './files.service';

@Module({
  controllers: [FilesController, FileServeController, PublicBrandingController],
  providers: [FilesService],
})
export class FilesModule {}
