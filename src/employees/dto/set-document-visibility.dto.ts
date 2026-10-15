import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class SetDocumentVisibilityDto {
  @ApiProperty({
    description:
      'false hides the uploaded letter from the employee it belongs to; true shows it again.',
  })
  @IsBoolean()
  visibleToEmployee!: boolean;
}
