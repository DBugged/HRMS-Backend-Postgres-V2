// Purpose: Creates (or resets the password of) a Control Panel Super Admin - the account used to sign in to the Control
//   Panel. Needed once per environment to make the first OWNER, before the panel has a Super Admins screen to do it from.
// Usage: CC_ADMIN_EMAIL=you@company.com CC_ADMIN_NAME="Your Name" CC_ADMIN_PASSWORD='a long password' \
//          npx ts-node scripts/create-super-admin.ts
//   CC_ADMIN_ROLE is OWNER by default (OWNER | ADMIN | SUPPORT | BILLING | READ_ONLY). Running it again for the same email
//   sets that account's password and role and unlocks it.
// Important: the password comes from the environment, not from the command line text, so it is not saved in the shell
//   history by the script itself. Nothing is printed except the email and role. The password has to pass the same strength
//   rule as the sign-in (12+ characters, upper and lower case, a number).
import { PrismaClient, SuperAdminRole } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';
import { normalizeEmail, passwordProblem } from '../src/control-center/cc-auth-rules';

async function main() {
  const email = normalizeEmail(process.env.CC_ADMIN_EMAIL ?? '');
  const name = (process.env.CC_ADMIN_NAME ?? '').trim() || 'Super Admin';
  const password = process.env.CC_ADMIN_PASSWORD ?? '';
  const role = (process.env.CC_ADMIN_ROLE ?? 'OWNER') as SuperAdminRole;

  if (!email.includes('@')) throw new Error('Set CC_ADMIN_EMAIL.');
  if (!['OWNER', 'ADMIN', 'SUPPORT', 'BILLING', 'READ_ONLY'].includes(role)) throw new Error('CC_ADMIN_ROLE is not a valid role.');
  const problem = passwordProblem(password);
  if (problem) throw new Error(`CC_ADMIN_PASSWORD: ${problem}`);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const existing = await prisma.superAdmin.findUnique({ where: { email } });
    await prisma.superAdmin.upsert({
      where: { email },
      create: { email, name, passwordHash, role, status: 'ACTIVE' },
      update: { passwordHash, role, status: 'ACTIVE', failedLoginAttempts: 0, lockedUntil: null },
    });
    console.log(`${existing ? 'Updated' : 'Created'} Super Admin ${email} (${role}).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
