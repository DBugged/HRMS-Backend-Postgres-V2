import { stampLines } from './selfie-stamp.service';

describe('stampLines', () => {
  it('lists title, place, battery and who, in that order', () => {
    expect(
      stampLines({
        title: 'Check-in - 14-10-2026 09:02 AM',
        who: 'Asha Rao (DP-00007) - Demo Company',
        place: 'Lat 19.076000, Lng 72.877700 (+/-12 m)',
        batteryPercent: 78,
      }),
    ).toEqual([
      'Check-in - 14-10-2026 09:02 AM',
      'Lat 19.076000, Lng 72.877700 (+/-12 m)',
      'Battery: 78% (reported by device)',
      'Asha Rao (DP-00007) - Demo Company',
    ]);
  });

  it('says plainly when location or battery was not available', () => {
    const lines = stampLines({ title: 'Check-out', who: 'X', place: null, batteryPercent: null });
    expect(lines[1]).toBe('Location not recorded');
    expect(lines[2]).toBe('Battery: not reported');
  });
});
