import { NotificationCategory } from '@prisma/client';
import { NotificationsService } from './notifications.service';

// A notification can carry the page that opening it goes to (stored in the existing `link` column).
function build() {
  const created: any[] = [];
  const prisma: any = {
    notification: {
      createMany: jest.fn(async ({ data }: any) => created.push(...data)),
      create: jest.fn(async ({ data }: any) => { created.push(data); return { id: 'n1', ...data }; }),
    },
  };
  const push: any = { notify: jest.fn() };
  const svc = new NotificationsService(prisma, null as never, null as never, push as never);
  return { svc, created };
}
const base = { organizationId: 'o', userId: 'u', title: 't', message: 'm', category: NotificationCategory.GENERAL };

describe('notification link', () => {
  it('stores the page the notification opens, for one and for many', async () => {
    const { svc, created } = build();
    await svc.createMany([{ ...base, link: '/employee-profile?id=e1&tab=documents' }]);
    await svc.create({ ...base, link: '/leaves' });
    expect(created.map((c) => c.link)).toEqual(['/employee-profile?id=e1&tab=documents', '/leaves']);
  });
  it('leaves link unset when there is none', async () => {
    const { svc, created } = build();
    await svc.createMany([base]);
    expect(created[0]).not.toHaveProperty('link');
  });
});
