import { Global, Module } from '@nestjs/common';
import { PlatformBrandController } from './platform-brand.controller';
import { PlatformBrandService } from './platform-brand.service';

// Global so the email gateway and the Control Center can use it without importing the module everywhere.
@Global()
@Module({ controllers: [PlatformBrandController], providers: [PlatformBrandService], exports: [PlatformBrandService] })
export class PlatformBrandModule {}
