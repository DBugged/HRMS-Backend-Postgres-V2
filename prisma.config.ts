import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma 7 moved the datasource URL out of schema.prisma and into this
// config file (used by `prisma migrate`/`prisma generate`). The runtime
// PrismaClient in src/prisma/prisma.service.ts is configured separately
// via the @prisma/adapter-pg driver adapter, pointed at the same
// DATABASE_URL — see that file for why the two are configured separately.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
