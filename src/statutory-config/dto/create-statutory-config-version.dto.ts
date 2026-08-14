import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateStatutoryConfigVersionDto {
  @ApiProperty({
    description:
      'Shape depends on the module — see statutory-config-validation.ts',
  })
  @IsObject()
  config!: Record<string, unknown>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiProperty({ example: '2026-04-01' })
  @Matches(DATE_RE, { message: 'effectiveFrom must be in YYYY-MM-DD format' })
  effectiveFrom!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
