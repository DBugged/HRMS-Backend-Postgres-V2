import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from 'class-validator';

/** Body of POST /employees/profile-reminders - remind these employees (or, with none given, everyone below 100%) to finish their profile. */
export class SendProfileRemindersDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  employeeIds?: string[];
}
