import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsUUID, ValidateIf } from 'class-validator';

/** Body of POST /employees/bulk-company - give several employees the same company (sister-company name), or none. */
export class BulkSetCompanyDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  employeeIds!: string[];

  @ApiProperty({ nullable: true, description: 'The company to set, or null to use the organization\'s own branding.' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  brandId!: string | null;
}
