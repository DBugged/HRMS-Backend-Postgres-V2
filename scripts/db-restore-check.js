// Restores the newest backup for DATABASE_URL's DB into a scratch database,
// runs sanity counts, then drops the scratch DB. Prints PASS/FAIL.
// Usage: npm run db:restore-check
require('dotenv/config');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const src = new URL(process.env.DATABASE_URL || 'x://');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
src.search = '';
const srcDb = decodeURIComponent(src.pathname.slice(1));
const scratchDb = `${srcDb}_restorecheck_${Date.now()}`.slice(0, 63);
if (scratchDb === srcDb) {
  console.error('Refusing: scratch DB name equals the source DB.');
  process.exit(1);
}
const admin = new URL(src.toString());
admin.pathname = '/postgres';
const scratch = new URL(src.toString());
scratch.pathname = '/' + scratchDb;

const dir = path.join(__dirname, '..', 'backups');
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.startsWith(`${srcDb}-`) && f.endsWith('.dump')).sort()
  : [];
if (!files.length) {
  console.error('FAIL: no backups found. Run npm run db:backup first.');
  process.exit(1);
}
const backup = path.join(dir, files[files.length - 1]);
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const psql = (u, sql) => run('psql', [u.toString(), '-XtAc', sql]);

let ok = false;
try {
  console.log(`Backup: ${backup}\nScratch DB: ${scratchDb}`);
  let r = psql(admin, `CREATE DATABASE "${scratchDb}"`);
  if (r.status !== 0) throw new Error('create scratch DB failed: ' + r.stderr);
  r = run('pg_restore', ['--no-owner', '-d', scratch.toString(), backup]);
  if (r.status !== 0) throw new Error('pg_restore failed: ' + r.stderr);

  const count = (t) => {
    const o = psql(scratch, `SELECT count(*) FROM ${t}`);
    if (o.status !== 0) throw new Error(`count ${t} failed: ${o.stderr}`);
    return Number(o.stdout.trim());
  };
  const orgs = count('organizations');
  const users = count('users');
  const migs = count('_prisma_migrations');
  console.log(`organizations=${orgs} users=${users} _prisma_migrations=${migs}`);
  ok = orgs > 0 && users > 0 && migs > 0;
  if (!ok) console.error('Sanity counts must all be > 0.');
} catch (e) {
  console.error(e.message);
} finally {
  const d = psql(admin, `DROP DATABASE IF EXISTS "${scratchDb}"`);
  if (d.status !== 0) console.error('WARNING: failed to drop scratch DB ' + scratchDb);
}
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
