import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsOptional, IsUUID, Matches } from 'class-validator';

/** Body of POST /employees/bulk-always-present - mark several employees present on every working day (or back to normal). */
export class BulkSetAlwaysPresentDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  employeeIds!: string[];

  @ApiProperty()
  @IsBoolean()
  alwaysPresent!: boolean;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD the marking starts from; today when left out.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD.' })
  from?: string;
}
