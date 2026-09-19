import {
  StoredChainRow,
  canonicalize,
  computeHash,
  verifyChain,
} from './audit-chain';

function buildChain(n: number): StoredChainRow[] {
  const rows: StoredChainRow[] = [];
  let prev = '';
  for (let i = 0; i < n; i++) {
    const base = {
      id: `id-${i}`,
      organizationId: 'org-1',
      actorId: 'user-1',
      actorRole: 'ADMIN',
      action: `ACTION_${i}`,
      category: 'SETTINGS',
      targetUserId: null,
      entity: 'PrivacySettings',
      entityId: null,
      result: 'SUCCESS',
      ip: '',
      userAgent: '',
      meta: { b: 2, a: { z: 1, y: [1, 2] } },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    };
    const hash = computeHash(prev, base);
    rows.push({ ...base, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

describe('audit-chain', () => {
  it('canonicalize sorts keys recursively and is order-independent', () => {
    expect(canonicalize({ b: 1, a: { d: 1, c: 2 } })).toBe(
      canonicalize({ a: { c: 2, d: 1 }, b: 1 }),
    );
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('verifies an intact chain, including after a JSON round-trip of meta/createdAt', () => {
    const rows = buildChain(5).map((r) => ({
      ...r,
      meta: JSON.parse(JSON.stringify(r.meta)) as unknown,
      createdAt: r.createdAt,
    }));
    const res = verifyChain(rows);
    expect(res.intact).toBe(true);
    expect(res.checked).toBe(5);
    expect(res.brokenAtIndex).toBeNull();
  });

  it('detects a tampered row', () => {
    const rows = buildChain(5);
    rows[2] = { ...rows[2], action: 'TAMPERED' };
    const res = verifyChain(rows);
    expect(res.intact).toBe(false);
    expect(res.brokenAtIndex).toBe(2);
    expect(res.reason).toBe('HASH_MISMATCH');
  });

  it('detects a deleted row (prevHash link broken)', () => {
    const rows = buildChain(5);
    rows.splice(2, 1);
    const res = verifyChain(rows);
    expect(res.intact).toBe(false);
    expect(res.brokenAtIndex).toBe(2);
    expect(res.reason).toBe('PREV_HASH_MISMATCH');
  });

  it('detects deletion of the first row', () => {
    const rows = buildChain(3).slice(1);
    expect(verifyChain(rows).brokenAtIndex).toBe(0);
  });

  it('supports batch verification with a carried prevHash and start index', () => {
    const rows = buildChain(6);
    const first = verifyChain(rows.slice(0, 3));
    const second = verifyChain(rows.slice(3), first.lastHash, 3);
    expect(second.intact).toBe(true);
    const bad = buildChain(6);
    bad[4] = { ...bad[4], result: 'FAILURE' };
    const second2 = verifyChain(bad.slice(3), first.lastHash, 3);
    expect(second2.brokenAtIndex).toBe(4);
  });
});
