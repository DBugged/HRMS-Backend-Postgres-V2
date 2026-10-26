import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { CHECKLIST_ITEM_KEYS } from '../offboarding-checklist';

/** Body of PATCH /offboarding/:id/checklist-owner - who owns one checklist item, and by when. Either field may be sent alone. */
export class UpdateChecklistOwnerDto {
  @ApiProperty({ enum: CHECKLIST_ITEM_KEYS })
  @IsIn([...CHECKLIST_ITEM_KEYS])
  item!: (typeof CHECKLIST_ITEM_KEYS)[number];

  // A user id; send an empty string to clear the owner.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ownerId?: string;

  @ApiPropertyOptional({ example: '2026-12-18' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dueDate must be a date in YYYY-MM-DD form.' })
  dueDate?: string;
}
