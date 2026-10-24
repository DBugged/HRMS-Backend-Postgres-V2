import { assertAccountCanLeave } from './account-guard';

const prismaWith = (user: object | null, otherAdmins = 0) =>
  ({ user: { findFirst: jest.fn().mockResolvedValue(user), count: jest.fn().mockResolvedValue(otherAdmins) } }) as never;

describe('assertAccountCanLeave', () => {
  it('blocks the founder account', async () => {
    await expect(assertAccountCanLeave(prismaWith({ role: 'ADMIN', isFounder: true, isActive: true }, 3), 'u', 'o')).rejects.toThrow(/registered company account/);
  });
  it('blocks the last active Admin', async () => {
    await expect(assertAccountCanLeave(prismaWith({ role: 'ADMIN', isFounder: false, isActive: true }, 0), 'u', 'o')).rejects.toThrow(/last active Admin/);
  });
  it('allows an Admin when another remains', async () => {
    await expect(assertAccountCanLeave(prismaWith({ role: 'ADMIN', isFounder: false, isActive: true }, 1), 'u', 'o')).resolves.toBeUndefined();
  });
  it('allows a regular employee', async () => {
    await expect(assertAccountCanLeave(prismaWith({ role: 'EMPLOYEE', isFounder: false, isActive: true }), 'u', 'o')).resolves.toBeUndefined();
  });
});
