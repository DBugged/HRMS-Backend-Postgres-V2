import { Module } from '@nestjs/common';
import { FilesController } from './files.controller';
import { FileServeController } from './file-serve.controller';
import { FilesService } from './files.service';

@Module({
  controllers: [FilesController, FileServeController],
  providers: [FilesService],
})
export class FilesModule {}
