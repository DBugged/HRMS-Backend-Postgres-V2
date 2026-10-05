import * as dotenv from 'dotenv';
import * as path from 'path';
import { disablePasswordRotationGuard } from './password-rotation-guard.testing';

// Same file each spec loads itself; loaded first here so the check below sees the real target database.
dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

// Safety net: the e2e specs TRUNCATE tables. Refuse to run unless the target database is clearly a disposable
// test DB (name ends in "_test"), so a mis-set DATABASE_URL can never wipe a dev or production database.
const dbName = new URL(
  process.env.DATABASE_URL ?? 'postgres://x/',
).pathname.replace(/^\//, '');
if (!/_test$/.test(dbName)) {
  throw new Error(
    `Refusing to run e2e tests against database "${dbName}": the specs truncate tables. Use a database whose name ends in "_test" (see .env.test).`,
  );
}

// Runs before every e2e spec — see password-rotation-guard.testing.ts for why
// the guard is off by default and which spec turns it back on.
disablePasswordRotationGuard();
