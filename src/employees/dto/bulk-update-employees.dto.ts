import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/** Body of POST /employees/bulk-update - give several employees the same department, reporting manager, work location or designation. */
export class BulkUpdateEmployeesDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  employeeIds!: string[];

  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() reportingManagerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() workLocationId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) designation?: string;
}
