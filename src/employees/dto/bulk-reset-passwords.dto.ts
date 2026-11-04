import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

/** Body of POST /employees/bulk-reset-passwords - new one-time passwords for several people, returned once for download. */
export class BulkResetPasswordsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  employeeIds!: string[];
}

/** Body of POST /employees/credentials-export-log - records that a credentials sheet was downloaded. */
export class CredentialsExportLogDto {
  @IsInt()
  @Min(1)
  count!: number;

  @IsOptional()
  @IsString()
  source?: string;
}
