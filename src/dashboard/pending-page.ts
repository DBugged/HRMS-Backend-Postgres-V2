// Purpose: Paging for the waiting-requests list (GET /dashboard/pending-items): which slice of the newest-first list
//   to return, and whether more are waiting after it.
// Important: pure. Each source is read one row past what the page needs (wanted()), so "more" is known without a count:
//   if the list is longer than the page's end, there is a next page.
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export interface PageRequest {
  offset: number;
  limit: number;
}

/** A page request from the query, with the defaults and the cap applied. */
export function pageRequest(offset?: number, limit?: number): PageRequest {
  const safeLimit = Math.min(Math.max(Math.trunc(limit ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const safeOffset = Math.max(Math.trunc(offset ?? 0) || 0, 0);
  return { offset: safeOffset, limit: safeLimit };
}

/** How many rows to read from each source so this page, and the check for a next one, are both covered. */
export const wanted = (page: PageRequest): number => page.offset + page.limit + 1;

/** The page's slice of the (already sorted) list, and whether anything comes after it. */
export function slicePage<T>(sorted: T[], page: PageRequest): { items: T[]; hasMore: boolean } {
  return {
    items: sorted.slice(page.offset, page.offset + page.limit),
    hasMore: sorted.length > page.offset + page.limit,
  };
}
