import { BadRequestException } from '@nestjs/common';
import { PlatformBrandService } from './platform-brand.service';

function make(rows: { key: string; value: unknown }[] = []) {
  const store = new Map(rows.map((r) => [r.key, r.value]));
  const prisma: any = {
    ccSetting: {
      findMany: jest.fn(async () => [...store].map(([key, value]) => ({ key, value }))),
      upsert: jest.fn(async ({ where, create, update }: any) => { store.set(where.key, store.has(where.key) ? update.value : create.value); }),
    },
  };
  return new PlatformBrandService(prisma);
}

describe('PlatformBrandService', () => {
  it('defaults to D\'Rect HR with no logo', async () => {
    expect(await make().get()).toEqual({ name: "D'Rect HR", logoUrl: null });
  });

  it('saves a new name and reads it back', async () => {
    const s = make();
    expect((await s.set({ name: '  Acme People  ' })).name).toBe('Acme People');
  });

  it('rejects a bad name and a bad or oversized logo', async () => {
    const s = make();
    await expect(s.set({ name: 'A' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.set({ name: 'x<y' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.set({ logo: 'http://x/y.png' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(s.set({ logo: 'data:image/png;base64,' + 'A'.repeat(400_100) })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps and clears a valid logo', async () => {
    const s = make();
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect((await s.set({ logo: png })).logoUrl).toBe(png);
    expect((await s.set({ logo: null })).logoUrl).toBeNull();
  });

  it('swaps the default name in email text and html, escaping the html', async () => {
    const s = make([{ key: 'platform.brandName', value: 'Acme & Co' }]);
    expect(await s.applyToEmail("Welcome to D'Rect HR", false)).toBe('Welcome to Acme & Co');
    expect(await s.applyToEmail('<p>D&rsquo;RectHR by us, D&apos;Rect HR</p>', true)).toBe('<p>Acme &amp; Co by us, Acme &amp; Co</p>');
  });

  it('leaves text alone while the default name is in use', async () => {
    expect(await make().applyToEmail("Welcome to D'Rect HR", false)).toBe("Welcome to D'Rect HR");
  });
});
