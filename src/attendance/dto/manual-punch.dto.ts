import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class ManualPunchDto {
  @ApiProperty({ description: 'Employee UUID (User.id), not the human code' })
  @IsNotEmpty()
  @IsUUID()
  employeeId!: string;

  @ApiPropertyOptional({
    description: 'ISO 8601 timestamp; defaults to now if omitted',
  })
  @IsOptional()
  @IsNotEmpty()
  @IsISO8601()
  punchTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsLongitude()
  longitude?: number;
}
