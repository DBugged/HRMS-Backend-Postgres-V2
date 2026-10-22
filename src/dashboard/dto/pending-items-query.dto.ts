// Purpose: Query for GET /dashboard/pending-items - which kind of waiting request to list.
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../pending-page';

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

  // Paging. Either one switches the response from the plain list to { items, hasMore, offset, limit } so a long backlog
  // can be read page by page (newest first); without both the response is unchanged - the plain list of the newest 50.
  @ApiPropertyOptional({ description: 'How many to skip (newest first). Default 0.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ description: `Page size, default 50, at most ${MAX_PAGE_SIZE}.` })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}
