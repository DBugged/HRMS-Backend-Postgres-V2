import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsObject, IsOptional } from 'class-validator';
import { NotificationCategory } from '@prisma/client';

// Partial-update semantics — an omitted field keeps its prior value,
// matching the original release's merge-with-existing-prefs behavior.
export class UpdateNotificationPreferencesDto {
  @ApiPropertyOptional({ enum: NotificationCategory, isArray: true })
  @IsOptional()
  @IsArray()
  @IsEnum(NotificationCategory, { each: true })
  mutedCategories?: NotificationCategory[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  // Per kind and channel: { LEAVE: { email: false, push: true }, PAYROLL: { inApp: false } }. Categories: LEAVE,
  // REGULARIZATION, PAYROLL, ATTENDANCE, GENERAL; channels: inApp, email, push. Only what is mentioned changes.
  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  channels?: Record<string, Record<string, boolean>>;
}
