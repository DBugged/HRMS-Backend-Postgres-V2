import { CompOffStatus } from '@prisma/client';

/**
 * Pure port of the old backend's comp-off ledger math
 * (`consumeCompOff`/`releaseCompOff`/`getCompOffAvailable` in
 * `leavePolicyEngine.js`). No DB access — callers pre-filter to
 * approved/partially_availed, non-expired rows and persist the returned
 * updates themselves (see comp-off.service.ts). Only imports Prisma's
 * CompOffStatus as a type (no client/DB dependency), so the function
 * result plugs directly into a Prisma update without a cast.
 */

export type ConsumableStatus =
  | typeof CompOffStatus.APPROVED
  | typeof CompOffStatus.PARTIALLY_AVAILED
  | typeof CompOffStatus.AVAILED;

export interface CompOffRow {
  id: string;
  daysEarned: number;
  daysAvailed: number;
  expiryDate: string | null; // YYYY-MM-DD, null = never expires
  status: CompOffStatus;
}

export interface ConsumptionResult {
  updated: { id: string; daysAvailed: number; status: ConsumableStatus }[];
  // > 0 if there wasn't enough available balance across all rows — callers
  // should treat this as "insufficient comp-off balance" and not apply
  // any of the returned updates.
  shortfall: number;
}

function sortByExpirySoonestFirst(rows: CompOffRow[]): CompOffRow[] {
  return [...rows].sort((a, b) => {
    if (a.expiryDate === b.expiryDate) return 0;
    if (a.expiryDate === null) return 1; // no expiry consumed last
    if (b.expiryDate === null) return -1;
    return a.expiryDate < b.expiryDate ? -1 : 1;
  });
}

function sortByExpiryLatestConsumedFirst(rows: CompOffRow[]): CompOffRow[] {
  return [...rows].sort((a, b) => {
    if (a.expiryDate === b.expiryDate) return 0;
    if (a.expiryDate === null) return -1; // no-expiry rows released first
    if (b.expiryDate === null) return 1;
    return a.expiryDate > b.expiryDate ? -1 : 1;
  });
}

// Consumes `days` of comp-off across `rows`, soonest-expiring first.
export function consumeCompOff(
  rows: CompOffRow[],
  days: number,
): ConsumptionResult {
  let remaining = days;
  const updated: ConsumptionResult['updated'] = [];

  for (const row of sortByExpirySoonestFirst(rows)) {
    if (remaining <= 0) break;
    const available = row.daysEarned - row.daysAvailed;
    if (available <= 0) continue;

    const portion = Math.min(available, remaining);
    const newAvailed = row.daysAvailed + portion;
    updated.push({
      id: row.id,
      daysAvailed: newAvailed,
      status: newAvailed >= row.daysEarned ? 'AVAILED' : 'PARTIALLY_AVAILED',
    });
    remaining -= portion;
  }

  return { updated, shortfall: Math.max(remaining, 0) };
}

// Reverses a cancellation — gives `days` back across rows with
// daysAvailed > 0, most-recently-consumed first (mirrors releaseCompOff's
// expiryDate DESC ordering).
export function releaseCompOff(
  rows: CompOffRow[],
  days: number,
): { id: string; daysAvailed: number; status: ConsumableStatus }[] {
  let remaining = days;
  const updated: {
    id: string;
    daysAvailed: number;
    status: ConsumableStatus;
  }[] = [];

  for (const row of sortByExpiryLatestConsumedFirst(rows)) {
    if (remaining <= 0) break;
    if (row.daysAvailed <= 0) continue;

    const portion = Math.min(row.daysAvailed, remaining);
    const newAvailed = row.daysAvailed - portion;
    updated.push({
      id: row.id,
      daysAvailed: newAvailed,
      status: newAvailed > 0 ? 'PARTIALLY_AVAILED' : 'APPROVED',
    });
    remaining -= portion;
  }

  return updated;
}

// Sum of unconsumed comp-off across the given (already-filtered) rows.
export function sumAvailable(rows: CompOffRow[]): number {
  return rows.reduce((sum, row) => sum + (row.daysEarned - row.daysAvailed), 0);
}
