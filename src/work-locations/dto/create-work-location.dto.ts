import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { FenceType } from '@prisma/client';

// boundary's shape depends on fenceType (bounds for RECTANGLE, vertices for
// POLYGON, absent for CIRCLE) — validated by geometry-validation.ts in the
// service rather than per-key here, mirroring the old controller's
// runtime validateGeometry() rather than a rigid DTO shape per fence type.
export class GeoFenceBoundaryDto {
  @ApiPropertyOptional({
    description:
      'Two opposite corners for a RECTANGLE fence: [[lat,lng],[lat,lng]]',
  })
  @IsOptional()
  bounds?: [number, number][];

  @ApiPropertyOptional({
    description: 'At least 3 points for a POLYGON fence: [[lat,lng], ...]',
  })
  @IsOptional()
  vertices?: [number, number][];
}

export class CreateWorkLocationDto {
  @ApiProperty({ example: 'HQ - Mumbai' })
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    description:
      'Required for CIRCLE. For RECTANGLE/POLYGON, derived automatically if omitted.',
  })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  longitude?: number;

  // A zero/negative radius silently breaks the punch-in/out distance check
  // (attendance-shift-config.ts) rather than rejecting the request.
  @ApiPropertyOptional({ default: 200 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  radiusMeters?: number;

  @ApiPropertyOptional({ enum: FenceType, default: FenceType.CIRCLE })
  @IsOptional()
  @IsEnum(FenceType)
  fenceType?: FenceType;

  @ApiPropertyOptional({ type: GeoFenceBoundaryDto })
  @IsOptional()
  @IsObject()
  boundary?: { bounds?: [number, number][]; vertices?: [number, number][] };
}
