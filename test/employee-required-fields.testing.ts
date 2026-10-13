import { Client } from 'pg';
import request from 'supertest';
import type { Test } from 'supertest';

// ---------------------------------------------------------------------------
// POST /employees now requires a department, designation, employee category and
// work location - the same four the Add Employee form and Excel import require.
//
// Nearly every e2e spec builds its fixtures through POST /employees with only a
// name and email. Rather than add four fields (and a work location per org) to
// ~190 call sites - which would bury what each spec is actually testing - this
// patches supertest so that such a request is topped up with the organisation's
// first department / work location / designation / category (created through the
// API when the org has none yet). Fields a spec sets itself are never touched.
//
// A spec that wants the raw request - e.g. to prove the fields are required -
// sends the `x-e2e-raw: 1` header and gets no defaults.
//
// Fixtures are meant to stay exactly as they were before the fields became required
// (many specs rely on an employee with no department or no work location), so the
// fields topped up here are cleared again in the test database right after the
// create. A spec that wants the topped-up values to stay - employees.e2e-spec.ts -
// calls keepRequiredEmployeeFields().
// ---------------------------------------------------------------------------

type Defaults = {
  departmentId: string;
  workLocationId: string;
  designation: string;
  employeeCategory: string;
};

const NULLABLE_COLUMNS: Record<string, string> = {
  departmentId: `"departmentId" = NULL`,
  workLocationId: `"workLocationId" = NULL`,
  designation: `designation = ''`,
  employeeCategory: `"employeeCategory" = ''`,
};

async function clearColumns(userId: string, fields: string[]): Promise<void> {
  const sets = fields.map((f) => NULLABLE_COLUMNS[f]).filter(Boolean);
  if (sets.length === 0) return;
  const url = (process.env.DATABASE_URL ?? '').replace(/\?schema=.*$/, '');
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, [
      userId,
    ]);
  } finally {
    await client.end();
  }
}

let keepFields = false;

// Keep the topped-up department / work location / designation / category on the created employee.
export function keepRequiredEmployeeFields(): void {
  keepFields = true;
}

const cache = new Map<string, Promise<Defaults | null>>();

type Req = { app: unknown };

async function firstOrCreate(
  app: unknown,
  auth: string,
  listUrl: string,
  createUrl: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const server = app as Parameters<typeof request>[0];
  const list = await request(server).get(listUrl).set('Authorization', auth);
  const rows = (list.body as { data?: Record<string, unknown>[] }).data ?? [];
  if (rows.length > 0) return rows[0];
  const created = await request(server)
    .post(createUrl)
    .set('Authorization', auth)
    .send(body);
  const made = created.body as { data?: Record<string, unknown> };
  return (made.data ?? (created.body as Record<string, unknown>)) || null;
}

function resolveDefaults(app: unknown, auth: string): Promise<Defaults | null> {
  let pending = cache.get(auth);
  if (!pending) {
    pending = (async () => {
      const dept = await firstOrCreate(
        app,
        auth,
        '/departments',
        '/departments',
        { name: 'E2E Default Dept', code: 'E2EDD' },
      );
      const loc = await firstOrCreate(
        app,
        auth,
        '/work-locations',
        '/work-locations',
        {
          name: 'E2E Default Location',
          latitude: 19.07,
          longitude: 72.87,
          radiusMeters: 200,
        },
      );
      const desig = await firstOrCreate(
        app,
        auth,
        '/org-list-items?type=DESIGNATION',
        '/org-list-items',
        { type: 'DESIGNATION', name: 'E2E Default Designation' },
      );
      const cat = await firstOrCreate(
        app,
        auth,
        '/org-list-items?type=EMPLOYEE_CATEGORY',
        '/org-list-items',
        { type: 'EMPLOYEE_CATEGORY', name: 'E2E Default Category' },
      );
      if (!dept?.id || !loc?.id || !desig?.name || !cat?.name) return null;
      return {
        departmentId: String(dept.id),
        workLocationId: String(loc.id),
        designation: String(desig.name),
        employeeCategory: String(cat.name),
      };
    })();
    cache.set(auth, pending);
  }
  return pending;
}

export function fillRequiredEmployeeFields(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const TestClass =
    (require('supertest/lib/test') as { default?: unknown }).default ??
    (require('supertest/lib/test') as unknown);
  const proto = (TestClass as { prototype: Record<string, unknown> }).prototype;
  const originalEnd = proto.end as (this: unknown, fn?: unknown) => unknown;

  proto.end = function (
    this: Test & Req & Record<string, unknown>,
    fn?: unknown,
  ) {
    const self = this;
    const data = self['_data'] as Record<string, unknown> | undefined;
    const url = String(self['url'] ?? '');
    const isCreate =
      String(self['method']).toUpperCase() === 'POST' &&
      /\/employees$/.test(url.split('?')[0]) &&
      data &&
      typeof data === 'object' &&
      !Array.isArray(data);
    const header = (name: string) =>
      (self as unknown as { get(f: string): string | undefined }).get(name);
    if (!isCreate || header('x-e2e-raw')) {
      return originalEnd.call(self, fn);
    }
    const auth = header('authorization');
    const needs = [
      'departmentId',
      'workLocationId',
      'designation',
      'employeeCategory',
    ].some((k) => data[k] === undefined);
    if (!auth || !needs) return originalEnd.call(self, fn);
    void resolveDefaults(self.app, auth).then((defaults) => {
      const addedKeys = new Set<string>();
      if (defaults) {
        for (const [k, v] of Object.entries(defaults)) {
          if (data[k] === undefined) {
            data[k] = v;
            addedKeys.add(k);
          }
        }
      }
      if (keepFields || addedKeys.size === 0 || typeof fn !== 'function') {
        originalEnd.call(self, fn);
        return;
      }
      const done = fn as (err: unknown, res: unknown) => void;
      originalEnd.call(
        self,
        (err: unknown, res: { body?: { employee?: { id?: string } } }) => {
          const id = res?.body?.employee?.id;
          if (err || !id) return done(err, res);
          clearColumns(id, [...addedKeys]).then(
            () => done(err, res),
            (e: unknown) => done(e, res),
          );
        },
      );
    });
    return self;
  };
}
