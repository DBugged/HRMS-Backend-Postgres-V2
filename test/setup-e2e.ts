import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Test as SupertestTest } from 'supertest';

// ---------------------------------------------------------------------------
// Why this file exists
//
// PasswordRotationGuard (src/common/guards/password-rotation.guard.ts) blocks
// every non-allowlisted route while User.mustChangePassword is still true, so
// an emailed temporary password can no longer drive the whole API without ever
// being rotated.
//
// Almost every e2e spec creates its fixtures through POST /employees, which
// deliberately returns a temporary password with mustChangePassword = true,
// and then logs in with that temporary password and exercises the feature
// under test. That is a flow the product now forbids: a real user has to
// rotate first. Rather than bolt a change-password call onto ~140 fixture
// sites (which would also invalidate the temporary password that several
// specs reuse), this hook simulates "the user has already rotated" by
// clearing the flag right after any successful /auth/login.
//
// This is safe and non-masking:
//   * It clears DATA, never the guard. The guard stays registered and fully
//     active for every request in every spec; password-rotation.e2e-spec.ts
//     covers its actual behaviour end to end.
//   * It runs strictly AFTER the login response has been produced, so specs
//     that assert on user.mustChangePassword in the login body (auth.e2e-spec)
//     still see the true value.
//   * JwtAccessStrategy re-reads the user row on every request, so clearing
//     the flag here takes effect immediately on the token just issued —
//     no re-login needed.
// ---------------------------------------------------------------------------

let prisma: PrismaClient | null = null;
function db(): PrismaClient {
  // Same explicit driver adapter PrismaService uses — Prisma 7 has no
  // implicit url-from-schema connection at runtime.
  prisma ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  return prisma;
}

interface LoginBody {
  user?: { id?: string; mustChangePassword?: boolean };
}

// supertest's Test extends superagent's Request; .then()/.expect() both funnel
// through .end(), so patching it once covers every call style the specs use.
interface EndResponse {
  status: number;
  body: unknown;
}
type EndCallback = (err: unknown, res: EndResponse) => void;
interface PatchableTest {
  end: (fn: EndCallback) => unknown;
  url: string;
}
const proto = SupertestTest.prototype as unknown as PatchableTest;
const originalEnd: (this: PatchableTest, fn: EndCallback) => unknown =
  proto.end;

proto.end = function patchedEnd(this: PatchableTest, fn: EndCallback) {
  return originalEnd.call(this, (err: unknown, res: EndResponse) => {
    const user = (res?.body as LoginBody | undefined)?.user;
    if (
      !err &&
      typeof this.url === 'string' &&
      this.url.endsWith('/auth/login') &&
      res &&
      res.status < 400 &&
      user?.mustChangePassword === true &&
      user.id
    ) {
      const id = user.id;
      void db()
        .user.update({ where: { id }, data: { mustChangePassword: false } })
        .then(
          () => fn(err, res),
          () => fn(err, res),
        );
      return;
    }
    fn(err, res);
  });
};

afterAll(async () => {
  await prisma?.$disconnect();
  prisma = null;
});
