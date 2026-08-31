// Purpose: Exposes CRUD for the organization's letter templates.
// Responsibilities: Validates DTOs and delegates all logic to LetterTemplatesService.
// Important: findAll/findOne have no @Roles() — any authenticated caller can view the templates in effect
//   (the Letters tab on Employee Full Profile reads the active ones); create/update/delete are ADMIN/HR
//   only, same split as EmailTemplatesController.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { LetterTemplatesService } from './letter-templates.service';
import { UpdateLetterTemplateDto } from './dto/update-letter-template.dto';
import { CreateLetterTemplateDto } from './dto/create-letter-template.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('letter-templates')
@ApiBearerAuth('access-token')
@Controller('letter-templates')
export class LetterTemplatesController {
  constructor(private readonly letterTemplatesService: LetterTemplatesService) {}

  @Get()
  findAll(@CurrentUser() caller: Caller) {
    return this.letterTemplatesService.findAll(caller.organizationId);
  }

  @Get(':key')
  findOne(@Param('key') key: string, @CurrentUser() caller: Caller) {
    return this.letterTemplatesService.findByKey(key, caller.organizationId);
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateLetterTemplateDto, @CurrentUser() caller: Caller) {
    return this.letterTemplatesService.create(
      dto,
      caller.organizationId,
      caller.id,
    );
  }

  @Put(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateLetterTemplateDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.letterTemplatesService.update(
      id,
      dto,
      caller.organizationId,
      caller.id,
    );
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.letterTemplatesService.delete(
      id,
      caller.organizationId,
      caller.id,
    );
  }
}
