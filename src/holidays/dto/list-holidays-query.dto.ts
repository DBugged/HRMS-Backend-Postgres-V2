import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { HolidayType } from '@prisma/client';

export class ListHolidaysQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({
    description: 'Returns holidays for this department OR company-wide',
  })
  @IsOptional()
  @IsUUID()
  department?: string;

  @ApiPropertyOptional({ enum: HolidayType })
  @IsOptional()
  @IsEnum(HolidayType)
  type?: HolidayType;
}
