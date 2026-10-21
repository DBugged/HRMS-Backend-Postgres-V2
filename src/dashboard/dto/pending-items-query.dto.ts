// Purpose: Query for GET /dashboard/pending-items - which kind of waiting request to list.
import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const PENDING_ITEM_TYPES = [
  'LEAVE',
  'REGULARIZATION',
  'WFH',
  'OVERTIME',
  'COMP_OFF',
  'REIMBURSEMENT',
  'LOAN',
  'ENCASHMENT',
  'RESIGNATION',
  'RESIGNATION_WITHDRAWAL',
] as const;
export type PendingItemType = (typeof PENDING_ITEM_TYPES)[number];

export class PendingItemsQueryDto {
  @ApiProperty({ enum: PENDING_ITEM_TYPES })
  @IsIn(PENDING_ITEM_TYPES)
  type!: PendingItemType;
}
