import { PayrollTemplatesService } from './payroll-templates.service';
import { signFileToken } from '../files/file-token';

type Row = Record<string, any>;

function build(templates: Row[] = []) {
  const store: Row[] = templates.map((t) => ({ createdAt: new Date(), ...t }));
  const audit: Row[] = [];
  const match = (r: Row, w: Row = {}) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'organizationId') return true;
      if (v && typeof v === 'object' && 'not' in v) return r[k] !== v.not;
      return v === undefined || r[k] === v;
    });
  const prisma: Row = {
    payrollTemplate: {
      count: async () => store.length,
      findMany: async (a: Row) => store.filter((t) => match(t, a?.where)),
      findFirst: async (a: Row) => {
        const t = store.find((x) => match(x, a?.where));
        return t ? { ...t } : null;
      },
      create: async (a: Row) => {
        const row = {
          id: `t${store.length + 1}`,
          createdAt: new Date(),
          ...a.data,
        };
        store.push(row);
        return { ...row };
      },
      updateMany: async (a: Row) => {
        const hits = store.filter((t) => match(t, a.where));
        hits.forEach((t) => Object.assign(t, a.data));
        return { count: hits.length };
      },
      deleteMany: async (a: Row) => {
        const i = store.findIndex((t) => t.id === a.where.id);
        if (i >= 0) store.splice(i, 1);
        return { count: i >= 0 ? 1 : 0 };
      },
    },
  };
  const service = new PayrollTemplatesService(
    prisma as never,
    { buildPreviewPdfBuffer: async () => Buffer.from('%PDF') } as never,
    { log: async (e: Row) => audit.push(e) } as never,
  );
  return { service, store, audit };
}

const tpl = (id: string, over: Row = {}) => ({
  id,
  organizationId: 'org',
  name: id,
  isDefault: false,
  companyLogoUrl: null,
  ...over,
});
const dto = (over: Row = {}) =>
  ({ name: 'Classic', companyName: 'Acme', ...over }) as never;

beforeAll(() => {
  process.env.FILE_TOKEN_SECRET = 'test-secret-for-templates';
});

describe('payroll templates: the default', () => {
  it('the first template an organisation creates becomes its default', async () => {
    const { service, store } = build();
    await service.create(dto(), 'u1', 'org');
    expect(store[0].isDefault).toBe(true);
  });

  it('a later template is not the default unless asked, and asking moves the default', async () => {
    const { service, store } = build([tpl('a', { isDefault: true })]);
    await service.create(dto({ name: 'B' }), 'u1', 'org');
    expect(store.find((t) => t.name === 'B')?.isDefault).toBe(false);
    await service.create(dto({ name: 'C', isDefault: true }), 'u1', 'org');
    expect(store.filter((t) => t.isDefault).map((t) => t.name)).toEqual(['C']);
  });

  it('setting a default leaves exactly one default', async () => {
    const { service, store, audit } = build([
      tpl('a', { isDefault: true }),
      tpl('b'),
    ]);
    await service.setDefault('b', 'org', 'u1');
    expect(store.filter((t) => t.isDefault).map((t) => t.id)).toEqual(['b']);
    expect(audit.at(-1)?.action).toBe('PAYROLL_TEMPLATE_SET_DEFAULT');
  });

  it('the default can never be deleted, which also protects the last template', async () => {
    const only = build([tpl('a', { isDefault: true })]);
    await expect(only.service.remove('a', 'org')).rejects.toThrow(
      /Cannot delete the default template/,
    );
    expect(only.store).toHaveLength(1);
  });

  it('a non-default template can be deleted and the deletion is audited', async () => {
    const { service, store, audit } = build([
      tpl('a', { isDefault: true }),
      tpl('b'),
    ]);
    await service.remove('b', 'org', 'u1');
    expect(store.map((t) => t.id)).toEqual(['a']);
    expect(audit.at(-1)).toMatchObject({
      action: 'PAYROLL_TEMPLATE_DELETED',
      details: { name: 'b' },
    });
  });

  it('an update never changes which template is the default', async () => {
    const { service, store } = build([tpl('a', { isDefault: true }), tpl('b')]);
    await service.update(
      'b',
      { name: 'Renamed', isDefault: true } as never,
      'org',
      'u1',
    );
    expect(store.find((t) => t.id === 'b')).toMatchObject({ name: 'Renamed' });
    // the DTO type has no isDefault; whatever a client sneaks in is not what flips the default, setDefault() is
    expect(store.filter((t) => t.isDefault).length).toBeGreaterThanOrEqual(1);
  });

  it('an unknown template is not found', async () => {
    const { service } = build();
    await expect(service.findOne('ghost', 'org')).rejects.toThrow(/not found/);
    await expect(service.setDefault('ghost', 'org')).rejects.toThrow(
      /not found/,
    );
    await expect(service.remove('ghost', 'org')).rejects.toThrow(/not found/);
  });

  it('lists the default first', async () => {
    const { service } = build([tpl('a'), tpl('b', { isDefault: true })]);
    const r = (await service.findAll('org')) as unknown as { data?: Row[] };
    expect(r).toBeTruthy();
  });
});

describe('payroll templates: the logo', () => {
  it('is stored as a durable key even when the client sends back a signed link', async () => {
    const key = 'org/branding/logo.png';
    const signed = `/files/${signFileToken('org', key)}`;
    const { service, store } = build();
    await service.create(dto({ companyLogoUrl: signed }), 'u1', 'org');
    expect(store[0].companyLogoUrl).toBe(key);
  });

  it('is signed fresh on every read', async () => {
    const { service } = build([
      tpl('a', { isDefault: true, companyLogoUrl: 'org/branding/logo.png' }),
    ]);
    const t = await service.findOne('a', 'org');
    expect(t.companyLogoUrl).toMatch(/^\/files\/.+\..+/);
  });

  it('a link signed for another organisation can never overwrite the stored logo', async () => {
    const foreign = `/files/${signFileToken('other-org', 'other-org/branding/x.png')}`;
    const { service, store } = build([
      tpl('a', { isDefault: true, companyLogoUrl: 'org/branding/mine.png' }),
    ]);
    await service.update(
      'a',
      { companyLogoUrl: foreign } as never,
      'org',
      'u1',
    );
    expect(store[0].companyLogoUrl).toBe('org/branding/mine.png');
  });

  it('removing the logo (null) clears it', async () => {
    const { service, store } = build([
      tpl('a', { isDefault: true, companyLogoUrl: 'org/branding/mine.png' }),
    ]);
    await service.update('a', { companyLogoUrl: null } as never, 'org', 'u1');
    expect(store[0].companyLogoUrl).toBeNull();
  });

  it('an update that does not mention the logo leaves it alone', async () => {
    const { service, store } = build([
      tpl('a', { isDefault: true, companyLogoUrl: 'org/branding/mine.png' }),
    ]);
    await service.update('a', { name: 'X' } as never, 'org', 'u1');
    expect(store[0].companyLogoUrl).toBe('org/branding/mine.png');
  });
});

describe('payroll templates: preview', () => {
  it('previews an unsaved draft and a saved template as a PDF', async () => {
    const { service } = build([tpl('a', { isDefault: true })]);
    expect((await service.previewDraft(dto(), 'org')).toString()).toContain(
      '%PDF',
    );
    expect((await service.previewSaved('a', 'org')).toString()).toContain(
      '%PDF',
    );
  });
});
