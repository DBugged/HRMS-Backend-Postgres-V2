import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class DeleteAuditLogDto {
  @ApiProperty({ example: '2026-01-01', description: 'First day to delete (inclusive)' })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: '2026-03-31', description: 'Last day to delete (inclusive)' })
  @IsDateString()
  to!: string;
}
