// Purpose: where each letter belongs in an employee's journey, so the Letters tab can show them in the order they come up and the
//   employee directory can say what is due next.
// Responsibilities: pure rules, no database. Hiring -> Probation -> During employment -> Disciplinary -> Exit; the stage a person is
//   in follows their employment status; the directory's one-line letter status is worked out from which letters were issued.
// Important: a letter key this file does not know (a custom template) is OTHER and is listed last. "Issued" means the letter was
//   generated or emailed to the employee (the LETTER_ISSUED / LETTER_EMAILED audit entries) - it does not mean the person has seen it.
import { EmploymentStatus } from '@prisma/client';

export const LETTER_STAGES = [
  'HIRING',
  'PROBATION',
  'EMPLOYMENT',
  'DISCIPLINARY',
  'EXIT',
] as const;
export type KnownLetterStage = (typeof LETTER_STAGES)[number];
export type LetterStage = KnownLetterStage | 'OTHER';

const KEYS_BY_STAGE: Record<KnownLetterStage, string[]> = {
  HIRING: [
    'offerLetter',
    'appointmentLetter',
    'letterOfIntent',
    'backgroundVerificationConsent',
    'nda',
    'nonCompeteAgreement',
    'nonSolicitationAgreement',
    'trainingBond',
  ],
  PROBATION: ['confirmationLetter', 'probationExtensionLetter'],
  EMPLOYMENT: [
    'promotionLetter',
    'incrementLetter',
    'transferLetter',
    'salaryCertificate',
    'employmentVerificationLetter',
    'appreciationLetter',
  ],
  DISCIPLINARY: [
    'warningLetter',
    'showCauseNotice',
    'suspensionLetter',
    'abscondingNotice',
  ],
  EXIT: [
    'resignationAcceptance',
    'terminationLetter',
    'noticePeriodWaiver',
    'noDuesCertificate',
    'relievingLetter',
    'experienceCertificate',
    'fullFinalSettlement',
    'retirementLetter',
    'internshipCertificate',
  ],
};

const STAGE_OF_KEY = new Map<string, KnownLetterStage>(
  (Object.entries(KEYS_BY_STAGE) as [KnownLetterStage, string[]][]).flatMap(
    ([stage, keys]) => keys.map((k) => [k, stage] as const),
  ),
);

// Position of a built-in letter in the journey (offer before appointment, relieving before experience...), so lists read in the order
// letters actually come up. A custom template sorts after the built-in ones, keeping its own order.
const ORDER_OF_KEY = new Map<string, number>(
  LETTER_STAGES.flatMap((stage) => KEYS_BY_STAGE[stage]).map(
    (k, i) => [k, i] as const,
  ),
);
export const letterFlowOrder = (key: string): number =>
  ORDER_OF_KEY.get(key) ?? Number.MAX_SAFE_INTEGER;

export const stageOfLetterKey = (key: string): LetterStage =>
  STAGE_OF_KEY.get(key) ?? 'OTHER';

const FINAL_EXIT: EmploymentStatus[] = [
  EmploymentStatus.RELEASED,
  EmploymentStatus.TERMINATED,
  EmploymentStatus.ABSCONDED,
];
const SERVING_NOTICE: EmploymentStatus[] = [
  EmploymentStatus.NOTICE_PERIOD,
  EmploymentStatus.RESIGNED,
];

/** The stage of the journey a person is in right now. */
export function currentLetterStage(employee: {
  employmentStatus: EmploymentStatus;
  isActive: boolean;
}): KnownLetterStage {
  const s = employee.employmentStatus;
  if (
    !employee.isActive ||
    FINAL_EXIT.includes(s) ||
    SERVING_NOTICE.includes(s)
  )
    return 'EXIT';
  if (s === EmploymentStatus.ONBOARDING) return 'HIRING';
  if (
    s === EmploymentStatus.PROBATION ||
    s === EmploymentStatus.EXTENDED_PROBATION
  )
    return 'PROBATION';
  return 'EMPLOYMENT';
}

export interface IssuedLetter {
  name: string;
  at: Date;
}

export interface LetterFlowStatus {
  stage: KnownLetterStage;
  /** One line for the directory column. */
  text: string;
  /** A letter that should have been issued by now is still missing. */
  due: boolean;
  latest: { name: string; at: Date } | null;
}

/**
 * What to tell HR about a person's letters, from their stage and what has been issued so far (`issued` is keyed by letter key
 * and holds the most recent issue of each).
 */
export function letterFlowStatus(
  employee: { employmentStatus: EmploymentStatus; isActive: boolean },
  issued: Map<string, IssuedLetter>,
): LetterFlowStatus {
  const stage = currentLetterStage(employee);
  let latest: IssuedLetter | null = null;
  for (const l of issued.values()) if (!latest || l.at > latest.at) latest = l;
  const out = (text: string, due = false): LetterFlowStatus => ({
    stage,
    text,
    due,
    latest: latest ? { name: latest.name, at: latest.at } : null,
  });

  if (stage === 'HIRING') {
    if (!issued.has('offerLetter')) return out('Offer letter due', true);
    if (!issued.has('appointmentLetter'))
      return out('Offer issued, appointment letter due', true);
    return out('Hiring letters issued');
  }
  if (stage === 'PROBATION') {
    return issued.has('confirmationLetter')
      ? out('Confirmation letter issued')
      : out('Awaiting confirmation letter');
  }
  if (stage === 'EXIT') {
    // Still working out the notice: the relieving letter and certificates come with the last day, so nothing is overdue yet.
    if (employee.isActive && !FINAL_EXIT.includes(employee.employmentStatus))
      return out('Serving notice, exit letters at relieving');
    if (!issued.has('relievingLetter'))
      return out('Relieving letter due', true);
    if (!issued.has('experienceCertificate'))
      return out('Experience certificate due', true);
    return out('Exit letters issued');
  }
  return latest ? out(`Last: ${latest.name}`) : out('No letters issued yet');
}
