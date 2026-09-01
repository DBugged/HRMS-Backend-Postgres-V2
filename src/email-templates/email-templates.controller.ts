// Purpose: Exposes CRUD for the organization's occasion-based email templates, plus its named signature
// list (Organization.emailSignatures — each template picks which one it uses).
// Responsibilities: Validates DTOs and delegates all logic to EmailTemplatesService.
// Important: findAll/findOne/listSignatures have no @Roles() — any authenticated caller can view the
// templates/signatures in effect; writes are ADMIN/HR only, same split as HolidaysController.
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
import { EmailTemplatesService } from './email-templates.service';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';
import { CreateEmailTemplateDto } from './dto/create-email-template.dto';
import { SendEmailTemplateDto } from './dto/send-email-template.dto';
import { CreateEmailSignatureDto } from './dto/create-email-signature.dto';
import { UpdateEmailSignatureDto } from './dto/update-email-signature.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('email-templates')
@ApiBearerAuth('access-token')
@Controller('email-templates')
export class EmailTemplatesController {
  constructor(private readonly emailTemplatesService: EmailTemplatesService) {}

  // No @Roles() — any authenticated caller can view the templates in effect.
  @Get()
  findAll(@CurrentUser() caller: Caller) {
    return this.emailTemplatesService.findAll(caller.organizationId);
  }

  // Registered ahead of the ':occasionKey' wildcard routes below — Nest
  // matches routes in registration order, so 'signatures' would otherwise
  // be captured as a literal occasionKey value instead of reaching these.
  @Get('signatures')
  listSignatures(@CurrentUser() caller: Caller) {
    return this.emailTemplatesService.listSignatures(caller.organizationId);
  }

  @Post('signatures')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  createSignature(
    @Body() dto: CreateEmailSignatureDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.emailTemplatesService.createSignature(
      dto,
      caller.organizationId,
      caller.id,
    );
  }

  @Put('signatures/:id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  updateSignature(
    @Param('id') id: string,
    @Body() dto: UpdateEmailSignatureDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.emailTemplatesService.updateSignatureById(
      id,
      dto,
      caller.organizationId,
      caller.id,
    );
  }

  @Delete('signatures/:id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  removeSignature(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.emailTemplatesService.deleteSignature(
      id,
      caller.organizationId,
      caller.id,
    );
  }

  @Get(':occasionKey')
  findOne(
    @Param('occasionKey') occasionKey: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.emailTemplatesService.findByOccasion(
      occasionKey,
      caller.organizationId,
    );
  }

  @Put(':occasionKey')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('occasionKey') occasionKey: string,
    @Body() dto: UpdateEmailTemplateDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.emailTemplatesService.update(
      occasionKey,
      dto,
      caller.organizationId,
      caller.id,
    );
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateEmailTemplateDto, @CurrentUser() caller: Caller) {
    return this.emailTemplatesService.create(
      dto,
      caller.organizationId,
      caller.id,
    );
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.emailTemplatesService.delete(
      id,
      caller.organizationId,
      caller.id,
    );
  }

  @Post(':id/send')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  send(
    @Param('id') id: string,
    @Body() dto: SendEmailTemplateDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.emailTemplatesService.sendManual(
      id,
      dto,
      caller.organizationId,
      caller,
    );
  }
}
