#!/usr/bin/env node
// Purpose: a quick check of the whole API for every role, run before a deploy (and on a schedule): can each role sign in, reach what
//   it should, and is it refused what it should not.
// Usage:   SMOKE_BASE_URL=http://localhost:4000 SMOKE_PASSWORD='...' node scripts/smoke.mjs
//   Accounts default to the demo ones (admin@demo.test, hr@demo.test, manager@demo.test, employee@demo.test); override with
//   SMOKE_ADMIN / SMOKE_HR / SMOKE_MANAGER / SMOKE_EMPLOYEE. Exits 1 if anything fails, so a pipeline stops the deploy.
// Important: read-only - it only signs in and GETs.
const BASE = (process.env.SMOKE_BASE_URL || 'http://localhost:4000').replace(/\/$/, '');
const PASSWORD = process.env.SMOKE_PASSWORD;
if (!PASSWORD) {
  console.error('Set SMOKE_PASSWORD to the password of the test accounts.');
  process.exit(2);
}
const ACCOUNTS = {
  ADMIN: process.env.SMOKE_ADMIN || 'admin@demo.test',
  HR: process.env.SMOKE_HR || 'hr@demo.test',
  MANAGER: process.env.SMOKE_MANAGER || 'manager@demo.test',
  EMPLOYEE: process.env.SMOKE_EMPLOYEE || 'employee@demo.test',
};

// [path, roles that must get 200, roles that must be refused (401/403)]
const CHECKS = [
  ['/employees', ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'], []],
  ['/employees/profile-scores', ['ADMIN', 'HR'], ['MANAGER', 'EMPLOYEE']],
  ['/notifications', ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'], []],
  ['/notifications/unread-count', ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'], []],
  ['/leaves', ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'], []],
  ['/attendance', ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'], []],
  ['/payroll', ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'], []],
  ['/payroll/readiness?month=10&year=2026', ['ADMIN', 'HR'], ['MANAGER', 'EMPLOYEE']],
  ['/reports/statutory-tracker', ['ADMIN', 'HR'], ['MANAGER', 'EMPLOYEE']],
  ['/audit-logs?limit=5', ['ADMIN', 'HR'], ['MANAGER', 'EMPLOYEE']],
  ['/org-health', ['ADMIN', 'HR'], ['EMPLOYEE']],
  ['/organizations/me', ['ADMIN', 'HR'], ['MANAGER', 'EMPLOYEE']],
  ['/departments', ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'], []],
  ['/holidays', ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'], []],
  ['/reimbursements', ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'], []],
  ['/loans', ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'], []],
];

let failures = 0;
const fail = (msg) => { failures += 1; console.error(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  ok    ${msg}`);

async function main() {
  const health = await fetch(`${BASE}/health`).catch(() => null);
  if (!health || health.status !== 200) fail(`GET /health -> ${health ? health.status : 'no answer'}`);
  else ok('GET /health');

  const tokens = {};
  for (const [role, email] of Object.entries(ACCOUNTS)) {
    const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) }).catch(() => null);
    const body = res && res.ok ? await res.json().catch(() => ({})) : {};
    const token = body.accessToken || body.access_token || body.data?.accessToken;
    if (!token) fail(`${role} cannot sign in (${email})`);
    else { tokens[role] = token; ok(`${role} signs in`); }
  }

  for (const [path, allowed, refused] of CHECKS) {
    for (const role of allowed) {
      if (!tokens[role]) continue;
      const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${tokens[role]}` } }).catch(() => null);
      if (!res || res.status !== 200) fail(`${role} GET ${path} -> ${res ? res.status : 'no answer'} (expected 200)`);
    }
    for (const role of refused) {
      if (!tokens[role]) continue;
      const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${tokens[role]}` } }).catch(() => null);
      if (!res || ![401, 403].includes(res.status)) fail(`${role} GET ${path} -> ${res ? res.status : 'no answer'} (expected 403)`);
    }
  }
  console.log(failures === 0 ? '\nSmoke test passed.' : `\nSmoke test FAILED: ${failures} problem${failures === 1 ? '' : 's'}.`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
