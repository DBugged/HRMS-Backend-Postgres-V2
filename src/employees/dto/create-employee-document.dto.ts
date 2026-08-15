import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateEmployeeDocumentDto {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  docType!: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  fileName!: string;

  // A relativeKey from POST /files/upload/documents.
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  fileUrl!: string;
}
