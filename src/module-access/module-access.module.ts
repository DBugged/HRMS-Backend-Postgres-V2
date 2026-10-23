import { Global, Module } from '@nestjs/common';
import { ModuleAccessController } from './module-access.controller';
import { ModuleAccessService } from './module-access.service';
import { ModuleGuard } from './module.guard';

// Global so the Control Center can clear the cache and app.module can register the guard.
@Global()
@Module({ controllers: [ModuleAccessController], providers: [ModuleAccessService, ModuleGuard], exports: [ModuleAccessService, ModuleGuard] })
export class ModuleAccessModule {}
