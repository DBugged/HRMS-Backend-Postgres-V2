import { evaluateTenantScope } from './tenant-scope.guard-logic';

describe('evaluateTenantScope', () => {
  describe('non-scoped models', () => {
    it('passes Organization queries through untouched (it IS the tenant, not owned by one)', () => {
      const args = { where: { id: 'org-1' } };
      expect(evaluateTenantScope('Organization', 'findFirst', args)).toBe(args);
    });

    it('passes through when model is undefined (e.g. a raw query)', () => {
      const args = { where: {} };
      expect(evaluateTenantScope(undefined, 'findFirst', args)).toBe(args);
    });
  });

  describe.each(['User', 'RefreshToken'])('%s (tenant-scoped)', (model) => {
    describe.each([
      'findMany',
      'findFirst',
      'count',
      'updateMany',
      'deleteMany',
    ])('%s', (operation) => {
      it('throws when organizationId is missing from where', () => {
        expect(() =>
          evaluateTenantScope(model, operation, { where: { id: 'x' } }),
        ).toThrow(/missing organizationId scope/);
      });

      it('throws when where is entirely absent', () => {
        expect(() => evaluateTenantScope(model, operation, {})).toThrow(
          /missing organizationId scope/,
        );
      });

      it('allows the query through when organizationId is present', () => {
        const args = { where: { id: 'x', organizationId: 'org-1' } };
        expect(evaluateTenantScope(model, operation, args)).toBe(args);
      });
    });

    describe.each(['findUnique', 'findUniqueOrThrow'])('%s', (operation) => {
      it('is forbidden outright, even with organizationId present', () => {
        expect(() =>
          evaluateTenantScope(model, operation, {
            where: { id: 'x', organizationId: 'org-1' },
          }),
        ).toThrow(/not allowed on a tenant-scoped model/);
      });
    });

    describe('create', () => {
      it('throws when the created row has no organizationId', () => {
        expect(() =>
          evaluateTenantScope(model, 'create', { data: { email: 'a@b.com' } }),
        ).toThrow(/missing organizationId on the created row/);
      });

      it('allows creation when organizationId is set', () => {
        const args = { data: { email: 'a@b.com', organizationId: 'org-1' } };
        expect(evaluateTenantScope(model, 'create', args)).toBe(args);
      });
    });

    describe('createMany', () => {
      it('throws if any row is missing organizationId', () => {
        expect(() =>
          evaluateTenantScope(model, 'createMany', {
            data: [{ organizationId: 'org-1' }, { email: 'no-org@b.com' }],
          }),
        ).toThrow(/every row must set organizationId/);
      });

      it('allows creation when every row has organizationId', () => {
        const args = {
          data: [{ organizationId: 'org-1' }, { organizationId: 'org-1' }],
        };
        expect(evaluateTenantScope(model, 'createMany', args)).toBe(args);
      });
    });

    describe('__tenantScopeBypass', () => {
      it('strips the bypass flag and allows an otherwise-unscoped query through', () => {
        const result = evaluateTenantScope(model, 'findFirst', {
          where: { email: 'a@b.com' },
          __tenantScopeBypass: true,
        });
        expect(result).toEqual({ where: { email: 'a@b.com' } });
        expect(result).not.toHaveProperty('__tenantScopeBypass');
      });

      it('does not affect findUnique/findUniqueOrThrow — bypass is checked first, so it is NOT forbidden when bypassed', () => {
        // Documents the actual precedence in evaluateTenantScope: the
        // bypass check runs before the FORBIDDEN_UNIQUE_OPS check, so a
        // deliberate tenant-resolution lookup could in principle use
        // findUnique too — no current call site does, but this locks in
        // the real behavior rather than an assumed one.
        const result = evaluateTenantScope(model, 'findUnique', {
          where: { email: 'a@b.com' },
          __tenantScopeBypass: true,
        });
        expect(result).toEqual({ where: { email: 'a@b.com' } });
      });
    });
  });

  describe('documented nested-write boundary', () => {
    // This isn't a test of evaluateTenantScope's internals — it's a
    // regression lock on the *scope* of what this guard can see at all.
    // Prisma's $allOperations extension hook only fires for operations
    // invoked directly on a model's own delegate (prisma.user.updateMany).
    // A nested write reached through another model's include/connect
    // (e.g. organization.update({ data: { users: { updateMany: {...} } } }))
    // is passed to Prisma as a single Organization.update call — this
    // function is never invoked with model: 'User' for it at all, so
    // there is nothing for evaluateTenantScope to catch. If a future
    // Prisma version changes this and starts surfacing nested writes as
    // separate per-model operations, this test's premise (that calling
    // evaluateTenantScope with the *outer* model name is what actually
    // happens today) should be revisited alongside it.
    it('would only ever see the outer model name for a nested write, never the nested one', () => {
      // Simulates what the extension actually receives for
      // organization.update({ data: { name: 'x', users: { updateMany: {...} } } }):
      // one call, model: 'Organization', not two calls including 'User'.
      const outerCallArgs = {
        where: { id: 'org-1' },
        data: { name: 'x', users: { updateMany: { where: {}, data: {} } } },
      };
      // Organization isn't tenant-scoped, so this passes through — the
      // nested User.updateMany hidden inside `data.users` is never
      // separately evaluated against TENANT_SCOPED_MODELS at all.
      expect(evaluateTenantScope('Organization', 'update', outerCallArgs)).toBe(
        outerCallArgs,
      );
    });
  });
});
