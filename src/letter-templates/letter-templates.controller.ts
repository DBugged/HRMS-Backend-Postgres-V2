// Purpose: Exposes CRUD for the organization's letter templates.
// Responsibilities: Validates DTOs and delegates all logic to LetterTemplatesService.
// Important: every route here is ADMIN/HR only - the templates (their full text) are not for other roles.
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
  constructor(
    private readonly letterTemplatesService: LetterTemplatesService,
  ) {}

  // Admin/HR only (the Letter Templates screen is theirs); other roles get 403.
  @Get()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  findAll(@CurrentUser() caller: Caller) {
    return this.letterTemplatesService.findAll(caller.organizationId);
  }

  @Get(':key')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
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
