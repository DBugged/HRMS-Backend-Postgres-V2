import { EmploymentStatus } from '@prisma/client';
import {
  currentLetterStage,
  letterFlowOrder,
  letterFlowStatus,
  stageOfTemplate,
  stageOfLetterKey,
  type IssuedLetter,
} from './letter-stages';

const at = (d: string) => new Date(`${d}T10:00:00Z`);
const issued = (...rows: [string, string, string][]) =>
  new Map<string, IssuedLetter>(
    rows.map(([key, name, d]) => [key, { name, at: at(d) }]),
  );
const emp = (employmentStatus: EmploymentStatus, isActive = true) => ({
  employmentStatus,
  isActive,
});

describe('letter stages', () => {
  it('places each built-in letter in its stage; a custom template is OTHER', () => {
    expect(stageOfLetterKey('offerLetter')).toBe('HIRING');
    expect(stageOfLetterKey('confirmationLetter')).toBe('PROBATION');
    expect(stageOfLetterKey('incrementLetter')).toBe('EMPLOYMENT');
    expect(stageOfLetterKey('warningLetter')).toBe('DISCIPLINARY');
    expect(stageOfLetterKey('relievingLetter')).toBe('EXIT');
    expect(stageOfLetterKey('myCustomLetter')).toBe('OTHER');
  });

  it('the stage a person is in follows their status', () => {
    expect(currentLetterStage(emp(EmploymentStatus.ONBOARDING))).toBe('HIRING');
    expect(currentLetterStage(emp(EmploymentStatus.PROBATION))).toBe(
      'PROBATION',
    );
    expect(currentLetterStage(emp(EmploymentStatus.EXTENDED_PROBATION))).toBe(
      'PROBATION',
    );
    expect(currentLetterStage(emp(EmploymentStatus.CONFIRMED))).toBe(
      'EMPLOYMENT',
    );
    expect(currentLetterStage(emp(EmploymentStatus.ON_HOLD))).toBe(
      'EMPLOYMENT',
    );
    expect(currentLetterStage(emp(EmploymentStatus.NOTICE_PERIOD))).toBe(
      'EXIT',
    );
    expect(currentLetterStage(emp(EmploymentStatus.CONFIRMED, false))).toBe(
      'EXIT',
    );
  });

  it('hiring: offer first, then appointment', () => {
    expect(
      letterFlowStatus(emp(EmploymentStatus.ONBOARDING), issued()),
    ).toMatchObject({ text: 'Offer letter due', due: true });
    expect(
      letterFlowStatus(
        emp(EmploymentStatus.ONBOARDING),
        issued(['offerLetter', 'Offer Letter', '2026-10-01']),
      ),
    ).toMatchObject({
      text: 'Offer issued, appointment letter due',
      due: true,
    });
    expect(
      letterFlowStatus(
        emp(EmploymentStatus.ONBOARDING),
        issued(
          ['offerLetter', 'Offer Letter', '2026-10-01'],
          ['appointmentLetter', 'Appointment Letter', '2026-10-05'],
        ),
      ),
    ).toMatchObject({ text: 'Hiring letters issued', due: false });
  });

  it('probation waits for the confirmation letter without calling it overdue', () => {
    expect(
      letterFlowStatus(emp(EmploymentStatus.PROBATION), issued()),
    ).toMatchObject({ text: 'Awaiting confirmation letter', due: false });
    expect(
      letterFlowStatus(
        emp(EmploymentStatus.PROBATION),
        issued(['confirmationLetter', 'Confirmation Letter', '2026-11-01']),
      ),
    ).toMatchObject({ text: 'Confirmation letter issued' });
  });

  it('during employment it names the last letter issued', () => {
    const s = letterFlowStatus(
      emp(EmploymentStatus.CONFIRMED),
      issued(
        ['appointmentLetter', 'Appointment Letter', '2025-01-01'],
        ['incrementLetter', 'Revised CTC Letter', '2026-04-01'],
      ),
    );
    expect(s).toMatchObject({
      text: 'Last: Revised CTC Letter',
      due: false,
      stage: 'EMPLOYMENT',
    });
    expect(s.latest?.name).toBe('Revised CTC Letter');
    expect(
      letterFlowStatus(emp(EmploymentStatus.CONFIRMED), issued()),
    ).toMatchObject({ text: 'No letters issued yet', latest: null });
  });

  it('exit: serving notice is not overdue; after the last day the relieving letter then the certificate are due', () => {
    expect(
      letterFlowStatus(emp(EmploymentStatus.NOTICE_PERIOD), issued()),
    ).toMatchObject({
      text: 'Serving notice, exit letters at relieving',
      due: false,
    });
    expect(
      letterFlowStatus(emp(EmploymentStatus.RELEASED, false), issued()),
    ).toMatchObject({ text: 'Relieving letter due', due: true });
    expect(
      letterFlowStatus(
        emp(EmploymentStatus.RELEASED, false),
        issued(['relievingLetter', 'Relieving Letter', '2026-11-01']),
      ),
    ).toMatchObject({ text: 'Experience certificate due', due: true });
    expect(
      letterFlowStatus(
        emp(EmploymentStatus.RELEASED, false),
        issued(
          ['relievingLetter', 'Relieving Letter', '2026-11-01'],
          ['experienceCertificate', 'Experience Certificate', '2026-11-01'],
        ),
      ),
    ).toMatchObject({ text: 'Exit letters issued', due: false });
  });

  it('orders letters as they come up: offer before appointment, relieving before experience, custom last', () => {
    const keys = [
      'experienceCertificate',
      'custom',
      'appointmentLetter',
      'relievingLetter',
      'offerLetter',
      'confirmationLetter',
    ];
    expect(
      [...keys].sort((a, b) => letterFlowOrder(a) - letterFlowOrder(b)),
    ).toEqual([
      'offerLetter',
      'appointmentLetter',
      'confirmationLetter',
      'relievingLetter',
      'experienceCertificate',
      'custom',
    ]);
  });

  it('a custom template goes where its admin put it; unset or unknown means Other; a built-in one ignores the setting', () => {
    expect(
      stageOfTemplate({
        key: 'bonusLetter',
        isCustom: true,
        journeyStage: 'EMPLOYMENT',
      }),
    ).toBe('EMPLOYMENT');
    expect(
      stageOfTemplate({ key: 'x', isCustom: true, journeyStage: 'EXIT' }),
    ).toBe('EXIT');
    expect(
      stageOfTemplate({ key: 'x', isCustom: true, journeyStage: null }),
    ).toBe('OTHER');
    expect(stageOfTemplate({ key: 'x', isCustom: true })).toBe('OTHER');
    expect(
      stageOfTemplate({ key: 'x', isCustom: true, journeyStage: 'NONSENSE' }),
    ).toBe('OTHER');
    expect(
      stageOfTemplate({
        key: 'offerLetter',
        isCustom: false,
        journeyStage: 'EXIT',
      }),
    ).toBe('HIRING');
  });
});
