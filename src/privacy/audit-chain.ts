// Purpose: Pure helpers for the tamper-evident, hash-chained privacy audit trail.
// Responsibilities: Canonicalizes an audit row, computes hash = sha256(prevHash + canonicalRow), and verifies an
// ordered list of rows, reporting the first index where the chain breaks.
// Important: Kept free of Prisma/Nest so it can be unit-tested against plain objects. The canonical form sorts
// object keys recursively and normalizes Dates to ISO strings, so a JSON round-trip through Postgres never
// changes a row's hash. Changing this format invalidates every existing chain — treat it as frozen.
import * as crypto from 'crypto';

export interface ChainRow {
  id: string;
  organizationId: string;
  actorId: string | null;
  actorRole: string;
  action: string;
  category: string;
  targetUserId: string | null;
  entity: string | null;
  entityId: string | null;
  result: string;
  ip: string;
  userAgent: string;
  meta: unknown;
  createdAt: Date | string;
}

export interface StoredChainRow extends ChainRow {
  prevHash: string;
  hash: string;
}

export interface ChainVerification {
  intact: boolean;
  checked: number;
  // Zero-based index (within the verified sequence) of the first bad row, or null when intact.
  brokenAtIndex: number | null;
  brokenRowId: string | null;
  reason: 'PREV_HASH_MISMATCH' | 'HASH_MISMATCH' | null;
  lastHash: string;
}

// JSON with recursively sorted keys — stable regardless of insertion order.
export function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function canonicalRow(row: ChainRow): string {
  return canonicalize({
    id: row.id,
    organizationId: row.organizationId,
    actorId: row.actorId ?? null,
    actorRole: row.actorRole ?? '',
    action: row.action,
    category: row.category,
    targetUserId: row.targetUserId ?? null,
    entity: row.entity ?? null,
    entityId: row.entityId ?? null,
    result: row.result,
    ip: row.ip ?? '',
    userAgent: row.userAgent ?? '',
    meta: row.meta ?? {},
    createdAt: new Date(row.createdAt).toISOString(),
  });
}

export function computeHash(prevHash: string, row: ChainRow): string {
  return crypto
    .createHash('sha256')
    .update(prevHash + canonicalRow(row))
    .digest('hex');
}

// Verifies rows already ordered oldest-first. `expectedPrevHash` is '' for the very first row of a chain; when
// verifying a later batch, pass the previous batch's lastHash.
export function verifyChain(
  rows: StoredChainRow[],
  expectedPrevHash = '',
  startIndex = 0,
): ChainVerification {
  let prev = expectedPrevHash;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.prevHash !== prev) {
      return {
        intact: false,
        checked: i,
        brokenAtIndex: startIndex + i,
        brokenRowId: row.id,
        reason: 'PREV_HASH_MISMATCH',
        lastHash: prev,
      };
    }
    if (computeHash(row.prevHash, row) !== row.hash) {
      return {
        intact: false,
        checked: i,
        brokenAtIndex: startIndex + i,
        brokenRowId: row.id,
        reason: 'HASH_MISMATCH',
        lastHash: prev,
      };
    }
    prev = row.hash;
  }
  return {
    intact: true,
    checked: rows.length,
    brokenAtIndex: null,
    brokenRowId: null,
    reason: null,
    lastHash: prev,
  };
}
