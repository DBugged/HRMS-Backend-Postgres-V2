import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsUUID } from 'class-validator';

export class AssignWorkScheduleDto {
  // Exact replace semantics — the departments assigned to this schedule
  // become exactly this list (an empty array unassigns everyone), same
  // "select the current set" UX as a permissions/membership picker.
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsUUID('4', { each: true })
  departmentIds!: string[];
}
