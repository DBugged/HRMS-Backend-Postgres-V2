import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// Unlike SendLetterDto's optional title/body (a one-off, unsaved edit for
// a single email), both fields here are required — this persists as the
// employee's new default content, so a blank value would silently wipe it.
export class SaveLetterContentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  title!: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20000)
  body!: string;
}
