import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, pageRequest, slicePage, wanted } from './pending-page';

describe('pending list paging', () => {
  it('applies the defaults and the cap', () => {
    expect(pageRequest()).toEqual({ offset: 0, limit: DEFAULT_PAGE_SIZE });
    expect(pageRequest(20, 500)).toEqual({ offset: 20, limit: MAX_PAGE_SIZE });
    expect(pageRequest(-5, 0)).toEqual({ offset: 0, limit: DEFAULT_PAGE_SIZE });
    expect(pageRequest(7.9, 10.2)).toEqual({ offset: 7, limit: 10 });
  });

  it('reads one row past the page from each source', () => {
    expect(wanted({ offset: 0, limit: 50 })).toBe(51);
    expect(wanted({ offset: 50, limit: 50 })).toBe(101);
  });

  it('returns the slice and says whether more follow', () => {
    const all = Array.from({ length: 7 }, (_, i) => i);
    expect(slicePage(all, { offset: 0, limit: 3 })).toEqual({ items: [0, 1, 2], hasMore: true });
    expect(slicePage(all, { offset: 3, limit: 3 })).toEqual({ items: [3, 4, 5], hasMore: true });
    expect(slicePage(all, { offset: 6, limit: 3 })).toEqual({ items: [6], hasMore: false });
    expect(slicePage(all, { offset: 3, limit: 4 })).toEqual({ items: [3, 4, 5, 6], hasMore: false });
    expect(slicePage(all, { offset: 20, limit: 3 })).toEqual({ items: [], hasMore: false });
  });
});
