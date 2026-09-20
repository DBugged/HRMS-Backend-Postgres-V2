// One-off, idempotent backfill: encrypts sensitive keys (PAN, Aadhaar, UAN, bank account, IFSC, passport, ESIC) inside
// users.personalData that are still plaintext. Lossless by construction and verified: every row is backed up to a
// JSON file first, and after writing each row is re-read and decrypted; a mismatch aborts (transaction rolled back).
//
// Run per environment (uses DATABASE_URL + PERSONAL_DATA_ENCRYPTION_KEY from ENV_FILE, default .env):
//   ENV_FILE=.env npx ts-node scripts/encrypt-personal-data.ts [--dry-run] [--backup-dir=<dir>]
// or: npm run encrypt:personal-data
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  decryptPersonalData,
  encryptPersonalData,
  ENCRYPTED_KEYS,
  isEncrypted,
} from '../src/common/personal-data-crypto';

dotenv.config({ path: process.env.ENV_FILE ?? '.env', override: true });

function hasPlaintextSensitive(pd: Record<string, unknown>): boolean {
  return Object.entries(pd).some(
    ([k, v]) =>
      ENCRYPTED_KEYS.has(k.toLowerCase()) &&
      typeof v === 'string' &&
      v !== '' &&
      !isEncrypted(v),
  );
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const backupDir =
    process.argv.find((a) => a.startsWith('--backup-dir='))?.split('=')[1] ??
    process.cwd();
  if (!process.env.PERSONAL_DATA_ENCRYPTION_KEY) {
    throw new Error(
      'PERSONAL_DATA_ENCRYPTION_KEY must be set for the backfill.',
    );
  }
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const orgs = await prisma.organization.findMany({ select: { id: true } });
  let total = 0;
  let encrypted = 0;
  for (const org of orgs) {
    const users = await prisma.user.findMany({
      where: { organizationId: org.id },
      select: { id: true, personalData: true },
    });
    total += users.length;
    const targets = users.filter((u) =>
      hasPlaintextSensitive((u.personalData ?? {}) as Record<string, unknown>),
    );
    if (targets.length === 0) continue;

    const file = path.join(
      backupDir,
      `personal-data-backup-${org.id}-${Date.now()}.json`,
    );
    fs.writeFileSync(
      file,
      JSON.stringify(
        targets.map((u) => ({ id: u.id, personalData: u.personalData })),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(`org ${org.id}: backed up ${targets.length} rows to ${file}`);
    if (dryRun) continue;

    await prisma.$transaction(async (tx) => {
      for (const u of targets) {
        const original = u.personalData as Record<string, unknown>;
        const enc = encryptPersonalData(original) as Record<string, unknown>;
        // Lossless check before writing.
        if (
          JSON.stringify(decryptPersonalData(enc)) !== JSON.stringify(original)
        ) {
          throw new Error(`Round-trip mismatch for user ${u.id}; aborting.`);
        }
        await tx.user.update({
          where: { id: u.id },
          data: { personalData: enc as Prisma.InputJsonValue },
        });
        // Verify what is actually stored.
        const stored = await tx.user.findUniqueOrThrow({
          where: { id: u.id },
          select: { personalData: true },
        });
        const back = decryptPersonalData(stored.personalData);
        if (
          JSON.stringify(sortKeys(back)) !== JSON.stringify(sortKeys(original))
        ) {
          throw new Error(
            `Stored-value verification failed for user ${u.id}; aborting.`,
          );
        }
        encrypted++;
      }
    });
  }
  console.log(
    `${dryRun ? '[dry-run] ' : ''}users scanned: ${total}, rows encrypted: ${encrypted}`,
  );
  await prisma.$disconnect();
}

// Postgres jsonb reorders keys, so compare order-insensitively.
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
