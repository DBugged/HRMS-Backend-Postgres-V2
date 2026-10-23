import { employeeLimitMessage, employeeRoom } from './employee-room';

describe('employeeRoom', () => {
  it('always allows when no hard limit is set', () => {
    expect(employeeRoom(null, 500)).toEqual({ allowed: true, max: null, used: 500 });
    expect(employeeRoom(undefined, 5).allowed).toBe(true);
  });
  it('allows up to the limit and refuses beyond it', () => {
    expect(employeeRoom(50, 49).allowed).toBe(true); // the 50th
    expect(employeeRoom(50, 50).allowed).toBe(false); // the 51st
  });
  it('counts a batch as one request', () => {
    expect(employeeRoom(50, 45, 5).allowed).toBe(true);
    expect(employeeRoom(50, 45, 6).allowed).toBe(false);
  });
  it('explains the limit in plain words', () => {
    expect(employeeLimitMessage({ allowed: false, max: 50, used: 50 })).toContain('up to 50 employees');
  });
});
