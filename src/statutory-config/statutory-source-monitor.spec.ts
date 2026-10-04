import { MONITORED_SOURCES, judgePage } from './statutory-source-monitor';

describe('statutory source monitor', () => {
  const pf = MONITORED_SOURCES.find((s) => s.key === 'pf-wage-ceiling')!;

  it('is OK when the page still carries the figures', () => {
    expect(
      judgePage(
        'wage ceiling Rs.25,000 ... Gazette Notification S.O. 5109(E)',
        pf.mustMatch,
      ),
    ).toBe('OK');
  });

  it('is CHANGED when a figure is missing', () => {
    expect(
      judgePage('wage ceiling Rs.30,000 ... S.O. 5109(E)', pf.mustMatch),
    ).toBe('CHANGED');
  });

  it('is UNREACHABLE (not CHANGED) when the page could not be read', () => {
    expect(judgePage(null, pf.mustMatch)).toBe('UNREACHABLE');
  });

  it('lists only HTTPS sources with at least one pattern', () => {
    for (const s of MONITORED_SOURCES) {
      expect(s.url.startsWith('https://')).toBe(true);
      expect(s.mustMatch.length).toBeGreaterThan(0);
    }
  });
});
