import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsOptional } from 'class-validator';

export class DeleteAuditLogDto {
  @ApiProperty({ example: '2026-01-01', description: 'First day to delete (inclusive)' })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: '2026-03-31', description: 'Last day to delete (inclusive)' })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({ description: 'Must be true to actually delete (not needed for the preview)' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  confirm?: boolean;
}
