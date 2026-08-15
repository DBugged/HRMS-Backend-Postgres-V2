import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AssignDepartmentHeadDto {
  @ApiProperty()
  @IsUUID()
  userId!: string;
}
