import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
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

  @ApiPropertyOptional({ description: 'Defaults to now if omitted' })
  @IsOptional()
  @IsString()
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
