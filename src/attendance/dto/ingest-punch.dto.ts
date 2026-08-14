import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

// The Face API webhook doesn't have a session — organizationId must be
// supplied by the caller, and employeeId here is the human-readable
// per-org code (User.employeeId), not the UUID primary key.
export class IngestPunchDto {
  @ApiProperty({ example: 'EMP0001' })
  @IsNotEmpty()
  @IsString()
  employeeId!: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  organizationId!: string;

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

  @ApiPropertyOptional({ description: 'Raw Face API payload, kept for audit' })
  @IsOptional()
  @IsObject()
  rawPayload?: Record<string, unknown>;
}
