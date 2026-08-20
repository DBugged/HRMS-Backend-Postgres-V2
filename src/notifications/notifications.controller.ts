// Purpose: Exposes endpoints to list, read, and set preferences for a caller's notifications, plus an admin broadcast.
// Responsibilities: Validates DTOs and delegates all logic to NotificationsService.
// Important: Only sendBroadcast is gated to ADMIN/HR; everything else self-scopes to the caller.
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { NotificationsService } from './notifications.service';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { SendNotificationDto } from './dto/send-notification.dto';
import { QueryNotificationsDto } from './dto/query-notifications.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  findMine(
    @Query() query: QueryNotificationsDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.notificationsService.findMine(
      query,
      caller,
      caller.organizationId,
    );
  }

  @Get('preferences')
  getPreferences(@CurrentUser() caller: Caller) {
    return this.notificationsService.getPreferences(caller);
  }

  @Put('preferences')
  updatePreferences(
    @Body() dto: UpdateNotificationPreferencesDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.notificationsService.updatePreferences(
      dto,
      caller,
      caller.organizationId,
    );
  }

  @Patch(':id/read')
  markAsRead(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.notificationsService.markAsRead(
      id,
      caller,
      caller.organizationId,
    );
  }

  @Patch('read-all')
  markAllAsRead(@CurrentUser() caller: Caller) {
    return this.notificationsService.markAllAsRead(
      caller,
      caller.organizationId,
    );
  }

  // Old system's hr_admin/administrator collapses to [ADMIN, HR].
  @Post('send')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  sendBroadcast(
    @Body() dto: SendNotificationDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.notificationsService.sendBroadcast(
      dto,
      caller,
      caller.organizationId,
    );
  }
}
