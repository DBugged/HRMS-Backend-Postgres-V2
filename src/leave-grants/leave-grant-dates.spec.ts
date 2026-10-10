// Purpose: Guards that leave-grant dates (typed or picked in the apps) must be real calendar dates.
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateLeaveGrantDto } from './dto/leave-grant.dto';

const base = {
  employeeId: '11111111-1111-4111-8111-111111111111',
  leaveTypeId: '22222222-2222-4222-8222-222222222222',
  eventDate: '2026-10-15',
};

const errors = (extra: object) =>
  validate(plainToInstance(CreateLeaveGrantDto, { ...base, ...extra })).then(
    (e) => e.map((x) => x.property),
  );

describe('leave grant dates', () => {
  it('accepts a real date', async () => {
    expect(await errors({})).not.toContain('eventDate');
  });
  it('rejects an impossible date that matches the YYYY-MM-DD shape', async () => {
    expect(await errors({ eventDate: '2026-02-30' })).toContain('eventDate');
    expect(await errors({ effectiveDate: '2026-13-01' })).toContain(
      'effectiveDate',
    );
  });
  it('rejects a partially typed year', async () => {
    expect(await errors({ eventDate: '0002-10-15' })).toContain('eventDate');
  });
});
