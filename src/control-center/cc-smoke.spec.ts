import { roleHas } from './cc-permissions';

describe('smoke test permission', () => {
  it('is held by the Super Admin (OWNER) only', () => {
    expect(roleHas('OWNER', 'smoke-test:run')).toBe(true);
    for (const role of ['ADMIN', 'SUPPORT', 'BILLING', 'READ_ONLY'] as const) expect(roleHas(role, 'smoke-test:run')).toBe(false);
  });
});
