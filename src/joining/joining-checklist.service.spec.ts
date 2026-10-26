import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { JoiningChecklistService } from './joining-checklist.service';

type Row = Record<string, any>;

function build(o: { people?: Row[]; existing?: string[]; items?: Row; owners?: Row | null } = {}) {
  const created: Row[] = [];
  const updated: Row[] = [];
  const notified: Row[] = [];
  const prisma: Row = {
    user: {
      findMany: async () => o.people ?? [],
      findFirst: async (a: Row) => (typeof a.where.role === 'string' ? { id: 'hr1' } : o.owners === undefined ? { id: a.where.id, name: 'Asha' } : o.owners),
    },
    joiningChecklist: {
      findMany: async () => (o.existing ?? []).map((employeeId) => ({ employeeId })),
      findFirst: async () => ({ id: 'jc1', items: o.items ?? { assets: { ownerId: 'hr1', dueDate: '2026-11-10', doneAt: null, doneById: null } } }),
      create: async (a: Row) => { created.push(a.data); },
      updateMany: async (a: Row) => { updated.push(a.data); },
    },
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
  };
  const notifications = { create: async (n: Row) => { notified.push(n); } };
  const svc = new JoiningChecklistService(prisma as never, notifications as never);
  jest.spyOn(svc, 'overview').mockResolvedValue({ cases: [{ employeeId: 'e1' }] } as never);
  return { svc, created, updated, notified };
}

const person = (id: string, joined: string) => ({ id, joiningDate: new Date(`${joined}T00:00:00Z`), reportingManagerId: 'm1' });
const hr = { id: 'hr1', role: 'HR' } as never;
const owner = { id: 'm1', role: 'MANAGER' } as never;

describe('JoiningChecklistService.ensureForOrg', () => {
  it('creates a checklist for recent and upcoming joiners only, and not twice', async () => {
    const { svc, created } = build({
      people: [person('new', '2026-10-25'), person('soon', '2026-11-10'), person('old', '2026-05-01'), person('has', '2026-10-25')],
      existing: ['has'],
    });
    expect(await svc.ensureForOrg('org', '2026-11-01')).toBe(2);
    expect(created.map((c) => c.employeeId).sort()).toEqual(['new', 'soon']);
    expect(created[0].items.assets.ownerId).toBe('hr1');
    expect(created[0].items.introduction.ownerId).toBe('m1');
  });
});

describe('JoiningChecklistService.updateItem', () => {
  it('lets HR change the owner and due date, and tells the new owner', async () => {
    const { svc, updated, notified } = build();
    await svc.updateItem('e1', 'assets', { ownerId: 'm1', dueDate: '2026-11-12' }, hr, 'org');
    expect(updated[0].items.assets).toMatchObject({ ownerId: 'm1', dueDate: '2026-11-12' });
    expect(notified[0]).toMatchObject({ userId: 'm1' });
  });

  it('lets the owner tick their own step', async () => {
    const { svc, updated } = build({ items: { assets: { ownerId: 'm1', dueDate: null, doneAt: null, doneById: null } } });
    await svc.updateItem('e1', 'assets', { done: true }, owner, 'org');
    expect(updated[0].items.assets.doneAt).toBeTruthy();
    expect(updated[0].items.assets.doneById).toBe('m1');
  });

  it('refuses someone who does not own the step, and an owner changing the owner or date', async () => {
    await expect(build().svc.updateItem('e1', 'assets', { done: true }, owner, 'org')).rejects.toThrow(ForbiddenException);
    const own = build({ items: { assets: { ownerId: 'm1', dueDate: null, doneAt: null, doneById: null } } });
    await expect(own.svc.updateItem('e1', 'assets', { dueDate: '2026-12-01' }, owner, 'org')).rejects.toThrow(ForbiddenException);
  });

  it('refuses an owner who is not an active Admin, HR or Manager', async () => {
    await expect(build({ owners: null }).svc.updateItem('e1', 'assets', { ownerId: '11111111-1111-1111-1111-111111111111' }, hr, 'org')).rejects.toThrow(/active Admin, HR or Manager/);
  });

  it('rejects an unknown step', async () => {
    await expect(build().svc.updateItem('e1', 'nope', { done: true }, hr, 'org')).rejects.toThrow(NotFoundException);
  });
});
