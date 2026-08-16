// The global default (ThrottlerModule.forRoot in app.module.ts) is 100
// req/min per IP — fine for ordinary CRUD/list traffic, but too loose for
// routes that do real work per request: report/export generation (Excel/
// PDF rendering, sometimes over an org's full history), bulk import
// execution, and payroll's calculate/bulk-transition (loops the formula
// engine over every targeted employee). A caller hammering one of those
// 100x/minute is a real resource-exhaustion vector even though it's
// technically "rate limited" by the default.
//
// Same env-override pattern as AUTH_THROTTLE_LIMIT (auth.controller.ts) —
// the e2e suite overrides this in .env.test since some specs legitimately
// call these routes more than the production default in a single run.
export const EXPENSIVE_OP_THROTTLE_LIMIT = Number(
  process.env.EXPENSIVE_OP_THROTTLE_LIMIT ?? 20,
);
