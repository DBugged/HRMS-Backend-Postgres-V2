import { compareEmployeeId, compareEmployees } from './employee-order';

describe('employee-order', () => {
  it('sorts IDs naturally', () => {
    const ids = [
      'DP-00010',
      'DP-00009',
      'DP-100000',
      'DP-99999',
      'AB-2',
      'AB-10',
    ];
    expect([...ids].sort(compareEmployeeId)).toEqual([
      'AB-2',
      'AB-10',
      'DP-00009',
      'DP-00010',
      'DP-99999',
      'DP-100000',
    ]);
  });

  it('tiebreaks on name', () => {
    const rows = [
      { employeeId: 'DP-00001', name: 'Zed' },
      { employeeId: 'DP-00001', name: 'Amy' },
    ];
    expect(rows.sort(compareEmployees).map((r) => r.name)).toEqual([
      'Amy',
      'Zed',
    ]);
  });
});
