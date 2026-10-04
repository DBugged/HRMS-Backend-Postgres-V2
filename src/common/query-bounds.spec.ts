// Purpose: Guards that list-query DTOs reject out-of-range numerics with a validation error (HTTP 400)
// instead of letting them reach Prisma, where they used to surface as 500s.
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListEmployeesQueryDto } from '../employees/dto/list-employees-query.dto';
import { QueryPayrollDto } from '../payroll/dto/query-payroll.dto';
import { ListHolidaysQueryDto } from '../holidays/dto/list-holidays-query.dto';

const errors = (cls: new () => object, plain: object) =>
  validate(plainToInstance(cls, plain)).then((e) => e.map((x) => x.property));

describe('query DTO numeric bounds', () => {
  it('rejects a huge page', async () => {
    expect(
      await errors(ListEmployeesQueryDto, { page: '99999999999999999999' }),
    ).toContain('page');
  });
  it('rejects out-of-range payroll month and year', async () => {
    const e = await errors(QueryPayrollDto, {
      month: '99999999999',
      year: '1',
    });
    expect(e).toEqual(expect.arrayContaining(['month', 'year']));
  });
  it('rejects an absurd holiday year but accepts a normal one', async () => {
    expect(
      await errors(ListHolidaysQueryDto, { year: '99999999999' }),
    ).toContain('year');
    expect(await errors(ListHolidaysQueryDto, { year: '2026' })).toEqual([]);
  });
});
