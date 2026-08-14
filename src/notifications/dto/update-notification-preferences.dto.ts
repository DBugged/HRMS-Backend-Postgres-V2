import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { NotificationCategory } from '@prisma/client';

// Partial-update semantics — an omitted field keeps its prior value,
// matching the old system's merge-with-existing-prefs behavior.
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
}
