import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ROLES_KEY } from '../decorators/roles.decorator';
import {
  SELF_OR_ROLES_KEY,
  SelfOrRolesMeta,
} from '../decorators/self-or-roles.decorator';

function makeContext(
  user: { id: string; role: string } | undefined,
  params: Record<string, string> = {},
) {
  return {
    getHandler: () => ({}) as never,
    getClass: () => ({}) as never,
    switchToHttp: () => ({
      getRequest: () => ({ user, params }),
    }),
  } as unknown as ExecutionContext;
}

// Reflector is mocked directly (rather than exercised through real
// decorator metadata on a fixture controller) so each test can control
// exactly what @Roles()/@SelfOrRoles() "returned" without needing NestJS's
// full DI/metadata machinery running in a unit test.
function makeReflector(overrides: {
  roles?: string[];
  selfOrRoles?: SelfOrRolesMeta;
}) {
  const reflector = new Reflector();
  jest
    .spyOn(reflector, 'getAllAndOverride')
    .mockImplementation((key: string) => {
      if (key === ROLES_KEY) return overrides.roles;
      if (key === SELF_OR_ROLES_KEY) return overrides.selfOrRoles;
      return undefined;
    });
  return reflector;
}

describe('RolesGuard', () => {
  it('allows the request through when neither @Roles nor @SelfOrRoles is present (auth-only route)', () => {
    const guard = new RolesGuard(makeReflector({}));
    expect(guard.canActivate(makeContext({ id: 'u1', role: 'EMPLOYEE' }))).toBe(
      true,
    );
  });

  it('defensively denies when somehow no user is on the request (JwtAuthGuard should already have rejected this)', () => {
    const guard = new RolesGuard(makeReflector({ roles: ['ADMIN'] }));
    expect(guard.canActivate(makeContext(undefined))).toBe(false);
  });

  describe('@Roles', () => {
    it('allows a user whose role is in the list', () => {
      const guard = new RolesGuard(makeReflector({ roles: ['ADMIN', 'HR'] }));
      expect(guard.canActivate(makeContext({ id: 'u1', role: 'HR' }))).toBe(
        true,
      );
    });

    it('rejects a user whose role is not in the list', () => {
      const guard = new RolesGuard(makeReflector({ roles: ['ADMIN', 'HR'] }));
      expect(() =>
        guard.canActivate(makeContext({ id: 'u1', role: 'EMPLOYEE' })),
      ).toThrow(ForbiddenException);
    });

    // Proves the mechanism is a generic array-membership check, not
    // hardcoded per-role branching — the same assertion the architecture
    // review made about a future Super Admin role being addable without
    // touching this guard's logic. This test can't add SUPER_ADMIN itself
    // (out of scope), but it does prove the guard has zero special-casing
    // tied to which specific roles happen to be passed in: any role list,
    // any role value, same code path.
    it('works identically regardless of which roles or how many are listed (no per-role special-casing)', () => {
      const combinations: Array<{
        allowed: string[];
        caller: string;
        expected: boolean;
      }> = [
        { allowed: ['ADMIN'], caller: 'ADMIN', expected: true },
        {
          allowed: ['MANAGER', 'EMPLOYEE'],
          caller: 'EMPLOYEE',
          expected: true,
        },
        {
          allowed: ['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'],
          caller: 'MANAGER',
          expected: true,
        },
        { allowed: ['ADMIN'], caller: 'HR', expected: false },
        // A role value that doesn't exist in the current Role enum at all —
        // the guard doesn't validate against a known-roles list, it just
        // checks array membership, so an unrecognized value is simply
        // "not in the allowed list" rather than a special error case. This
        // is exactly the property that makes adding a real new enum value
        // later a no-op for this guard.
        {
          allowed: ['ADMIN', 'HR'],
          caller: 'SOME_FUTURE_ROLE',
          expected: false,
        },
      ];

      for (const { allowed, caller, expected } of combinations) {
        const guard = new RolesGuard(makeReflector({ roles: allowed }));
        const context = makeContext({ id: 'u1', role: caller });
        if (expected) {
          expect(guard.canActivate(context)).toBe(true);
        } else {
          expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
        }
      }
    });
  });

  describe('@SelfOrRoles', () => {
    const meta: SelfOrRolesMeta = { roles: ['HR', 'MANAGER'], paramKey: 'id' };

    it('allows when the caller has one of the listed roles', () => {
      const guard = new RolesGuard(makeReflector({ selfOrRoles: meta }));
      const context = makeContext(
        { id: 'caller-1', role: 'HR' },
        { id: 'someone-else' },
      );
      expect(guard.canActivate(context)).toBe(true);
    });

    it("allows when the route param matches the caller's own id, regardless of role", () => {
      const guard = new RolesGuard(makeReflector({ selfOrRoles: meta }));
      const context = makeContext(
        { id: 'caller-1', role: 'EMPLOYEE' },
        { id: 'caller-1' },
      );
      expect(guard.canActivate(context)).toBe(true);
    });

    it('rejects when the caller has neither a listed role nor a matching id', () => {
      const guard = new RolesGuard(makeReflector({ selfOrRoles: meta }));
      const context = makeContext(
        { id: 'caller-1', role: 'EMPLOYEE' },
        { id: 'someone-else' },
      );
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('rejects when the target param is missing entirely', () => {
      const guard = new RolesGuard(makeReflector({ selfOrRoles: meta }));
      const context = makeContext({ id: 'caller-1', role: 'EMPLOYEE' }, {});
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });
  });
});
