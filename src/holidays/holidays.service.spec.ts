import { HolidaysService } from './holidays.service';

// Bulk import: a date that has already passed is accepted but saved as an INACTIVE reference record, so a whole-year
// calendar loads and nothing already calculated changes (every calculation reads only active holidays).
describe('HolidaysService.bulkImport - past dates', () => {
  const lastYear = new Date().getFullYear() - 1;
  const nextYear = new Date().getFullYear() + 1;

  function build() {
    const created: Record<string, unknown>[] = [];
    const prisma = {
      organization: {
        findFirst: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }),
      },
      holiday: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn(({ data }: { data: Record<string, unknown>[] }) => {
          created.push(...data);
          return Promise.resolve({ count: data.length });
        }),
      },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const service = new HolidaysService(prisma as never, audit as never);
    return { service, created, audit };
  }

  it('saves a past holiday as an inactive reference record and a future one as active', async () => {
    const { service, created } = build();
    const result = await service.bulkImport(
      {
        rows: [
          { name: 'Old Festival', date: `${lastYear}-03-10`, type: 'company' },
          { name: 'New Festival', date: `${nextYear}-03-10`, type: 'company' },
        ],
      } as never,
      'org-1',
      'user-1',
    );
    expect(result.created).toBe(2);
    expect(result.pastReferenceOnly).toBe(1);
    expect(result.failed).toEqual([]);
    const past = created.find((h) => h.name === 'Old Festival');
    const future = created.find((h) => h.name === 'New Festival');
    expect(past?.isActive).toBe(false);
    expect(past?.isReference).toBe(true);
    expect(future?.isActive).toBe(true);
    expect(future?.isReference).toBe(false);
  });

  it('still rejects an invalid date', async () => {
    const { service } = build();
    const result = await service.bulkImport(
      { rows: [{ name: 'Bad', date: 'not-a-date', type: 'company' }] } as never,
      'org-1',
    );
    expect(result.created).toBe(0);
    expect(result.failed[0].error).toMatch(/Invalid or missing Holiday Date/);
  });
});
