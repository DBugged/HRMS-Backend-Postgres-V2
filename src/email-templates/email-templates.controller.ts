// Purpose: Exposes CRUD for the organization's occasion-based email templates.
// Responsibilities: Validates DTOs and delegates all logic to EmailTemplatesService.
// Important: findAll/findOne have no @Roles() — any authenticated caller can view the templates in effect;
// update is ADMIN/HR only, same split as HolidaysController.
import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { EmailTemplatesService } from './email-templates.service';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';
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
}
