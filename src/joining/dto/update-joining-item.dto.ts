import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsUUID, Matches, ValidateIf } from 'class-validator';

/** Body of PATCH /joining-checklists/:employeeId/items/:key - any of the three; HR/Admin may send all, an owner only `done`. */
export class UpdateJoiningItemDto {
  @ApiPropertyOptional({ description: 'Tick (true) or untick (false) the step.' })
  @IsOptional()
  @IsBoolean()
  done?: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'Who owns the step (an active Admin, HR or Manager), or null for nobody.' })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @IsUUID()
  ownerId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'YYYY-MM-DD the step is due, or null.' })
  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dueDate must be YYYY-MM-DD.' })
  dueDate?: string | null;
}
