/**
 * Dev-only helper for manual RBAC verification: /auth/register always
 * creates an ADMIN founder, so there's no HTTP-only way to get an HR/
 * MANAGER/EMPLOYEE test account into a QA organization. This inserts one
 * of each directly via Prisma, bypassing the app entirely — not used by
 * any production code path.
 *
 * Usage: npx ts-node scripts/seed-qa-users.ts <organizationId>
 */
import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

const QA_PASSWORD = 'TestPass123!';

async function main() {
  const organizationId = process.argv[2];
  if (!organizationId) {
    console.error('Usage: npx ts-node scripts/seed-qa-users.ts <organizationId>');
    process.exit(1);
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const hashedPassword = await bcrypt.hash(QA_PASSWORD, 10);
  const roles: { role: Role; email: string }[] = [
    { role: Role.HR, email: 'qa-hr@example.test' },
    { role: Role.MANAGER, email: 'qa-manager@example.test' },
    { role: Role.EMPLOYEE, email: 'qa-employee@example.test' },
  ];

  for (const { role, email } of roles) {
    await prisma.user.create({
      data: {
        organizationId,
        email,
        password: hashedPassword,
        name: `QA ${role}`,
        role,
        mustChangePassword: false,
        emailVerified: true,
      },
    });
    console.log(`Created ${role}: ${email} / ${QA_PASSWORD}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
