// Canonical list-endpoint envelope. Every findAll/list method in this
// codebase returns exactly this shape now — no bare arrays, no
// module-specific wrapper keys (`records`, `logs`, `events`, ...). Kept as
// a plain interface (not a class) since it's a response shape, not
// something DTOs/validators ever construct.
export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

// The Prisma `skip` for a 1-indexed page — every paginate() call site
// computed this inline identically (`(query.page - 1) * query.limit`)
// rather than sharing one helper.
export function skip(page: number, limit: number): number {
  return (page - 1) * limit;
}

// Runs the findMany + count in parallel and wraps them in the canonical
// shape — used by every "Category A" list endpoint (attendance, leaves,
// payroll runs, comp-offs, reimbursements, etc.: collections that grow
// unboundedly over an organization's lifetime and need a real DB-backed
// total, not data.length).
export async function paginate<T>(
  findMany: () => Promise<T[]>,
  count: () => Promise<number>,
  page: number,
  limit: number,
): Promise<PaginatedResult<T>> {
  const [data, total] = await Promise.all([findMany(), count()]);
  return { data, total, page, limit };
}

// For genuinely small, config-like collections (holidays, work locations,
// departments, salary components, ...) where paging controls would be
// over-engineering — the UI always wants the complete list to build a
// dropdown/table/reorderable list, never a page-through view. Still
// returns the same {data,total,page,limit} envelope as `paginate()` so
// every list endpoint in the API has one consistent shape; page/limit are
// just always "1 page containing everything."
export function wrapAll<T>(data: T[]): PaginatedResult<T> {
  return { data, total: data.length, page: 1, limit: data.length || 1 };
}
