// pg_dump (custom format) of DATABASE_URL into ./backups/<db>-<timestamp>.dump.
// Usage: npm run db:backup -- [retentionCount]   (default keep newest 14; 0 = keep all)
require('dotenv/config');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}
const u = new URL(url);
u.search = ''; // pg_dump rejects Prisma's ?schema=... param
const db = decodeURIComponent(u.pathname.slice(1));
const keep = Number(process.argv[2] ?? 14);
if (!Number.isInteger(keep) || keep < 0) {
  console.error('Retention must be a non-negative integer.');
  process.exit(1);
}

const dir = path.join(__dirname, '..', 'backups');
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const file = path.join(dir, `${db}-${stamp}.dump`);

const r = spawnSync('pg_dump', ['-Fc', '--no-owner', '-f', file, u.toString()], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
if (r.status !== 0) {
  fs.rmSync(file, { force: true });
  console.error('pg_dump failed.');
  process.exit(1);
}
console.log(`Backup written: ${file} (${fs.statSync(file).size} bytes)`);

if (keep > 0) {
  // Timestamped names sort chronologically; prune only this DB's backups.
  const old = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${db}-`) && f.endsWith('.dump'))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) {
    fs.rmSync(path.join(dir, f));
    console.log(`Pruned ${f}`);
  }
}
