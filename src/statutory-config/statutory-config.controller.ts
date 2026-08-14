import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, StatutoryModule, User } from '@prisma/client';
import { StatutoryConfigService } from './statutory-config.service';
import { CreateStatutoryConfigVersionDto } from './dto/create-statutory-config-version.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { localDateStr } from '../employee-salary-components/salary-structure-math';

type Caller = Omit<User, 'password'>;

// Deliberately ADMIN-only, not the usual [ADMIN, HR] payroll-config
// collapse — the old system's comment is explicit: enabling a statutory
// module is an org-level compliance decision, not a routine payroll-admin
// task.
@ApiTags('statutory-config')
@ApiBearerAuth('access-token')
@Controller('statutory-config')
@Roles(Role.ADMIN)
@UseGuards(RolesGuard)
export class StatutoryConfigController {
  constructor(
    private readonly statutoryConfigService: StatutoryConfigService,
  ) {}

  @Get(':module')
  getHistory(@Param('module') module: string, @CurrentUser() caller: Caller) {
    const parsed = this.assertKnownModule(module);
    return this.statutoryConfigService.getHistory(
      parsed,
      caller.organizationId,
    );
  }

  @Get(':module/effective')
  getEffective(
    @Param('module') module: string,
    @Query('date') date: string | undefined,
    @CurrentUser() caller: Caller,
  ) {
    const parsed = this.assertKnownModule(module);
    return this.statutoryConfigService.getEffective(
      parsed,
      date ?? localDateStr(),
      caller.organizationId,
    );
  }

  @Post(':module')
  create(
    @Param('module') module: string,
    @Body() dto: CreateStatutoryConfigVersionDto,
    @CurrentUser() caller: Caller,
  ) {
    const parsed = this.assertKnownModule(module);
    return this.statutoryConfigService.create(
      parsed,
      dto,
      caller.id,
      caller.organizationId,
    );
  }

  @Delete(':module/:id')
  remove(
    @Param('module') module: string,
    @Param('id') id: string,
    @CurrentUser() caller: Caller,
  ) {
    const parsed = this.assertKnownModule(module);
    return this.statutoryConfigService.remove(
      parsed,
      id,
      caller.organizationId,
    );
  }

  private assertKnownModule(module: string): StatutoryModule {
    const upper = module.toUpperCase();
    if (!Object.values(StatutoryModule).includes(upper as StatutoryModule)) {
      throw new BadRequestException(`Unknown statutory module: ${module}`);
    }
    return upper as StatutoryModule;
  }
}
