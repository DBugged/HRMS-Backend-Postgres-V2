import { reportColumnsParam } from './report-columns-param';

const run = (url: string) => {
  const req: any = { url };
  const res: any = { locals: {} };
  reportColumnsParam(req, res, () => undefined);
  return { url: req.url, asked: res.locals.reportColumns };
};

describe('reportColumnsParam', () => {
  it('takes cols and listColumns out of the URL and leaves the rest alone', () => {
    expect(run('/reports/attendance?month=10&cols=name,email&year=2026')).toEqual({ url: '/reports/attendance?month=10&year=2026', asked: { cols: ['name', 'email'], list: false } });
    expect(run('/reports/attendance?listColumns=1')).toEqual({ url: '/reports/attendance', asked: { cols: [], list: true } });
  });
  it('does nothing for a URL without them', () => {
    expect(run('/reports/attendance?month=10')).toEqual({ url: '/reports/attendance?month=10', asked: undefined });
  });
});
