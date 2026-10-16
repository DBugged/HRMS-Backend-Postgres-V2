// Purpose: Turns a few plain answers (headcount, state, does PF/ESI/PT apply) into the statutory modules to switch on.
// Responsibilities: decides which of PF/ESI/PT to enable with India defaults, and flags where the law makes one
//   compulsory for the headcount so the guide can say so. Pure; StatutoryConfigService applies the plan.
// Important: PF is compulsory from 20 employees and ESI from 10 (both optional below that); PT slabs are state-wise and the
//   product supports Maharashtra only. LWF, gratuity and bonus are left off - they depend on facts a guide cannot ask in plain words.
import { StatutoryModule } from '@prisma/client';
import { SEED_DEFAULTS } from './statutory-config-validation';

export const PF_COMPULSORY_FROM = 20;
export const ESI_COMPULSORY_FROM = 10;
export const SETUP_STATE = 'Maharashtra';

export interface SetupAnswers {
  employeeCount: number;
  state: string;
  pf: boolean;
  esi: boolean;
  pt: boolean;
}

export interface SetupPlanItem {
  module: StatutoryModule;
  config: object;
}

export const isCompulsory = (
  module: 'PF' | 'ESI' | 'PT',
  employeeCount: number,
): boolean =>
  module === 'PF'
    ? employeeCount >= PF_COMPULSORY_FROM
    : module === 'ESI'
      ? employeeCount >= ESI_COMPULSORY_FROM
      : true;

/** What the guide pre-selects for a headcount: PF/ESI on once the law requires them, PT always. */
export function suggestedAnswers(employeeCount: number): {
  pf: boolean;
  esi: boolean;
  pt: boolean;
} {
  return {
    pf: isCompulsory('PF', employeeCount),
    esi: isCompulsory('ESI', employeeCount),
    pt: true,
  };
}

export function planSetup(a: SetupAnswers): SetupPlanItem[] {
  if (a.state !== SETUP_STATE) {
    throw new Error(
      'Only Maharashtra is supported for now, so other states cannot be set up yet.',
    );
  }
  const picks: [StatutoryModule, boolean][] = [
    [StatutoryModule.PF, a.pf],
    [StatutoryModule.ESI, a.esi],
    [StatutoryModule.PT, a.pt],
  ];
  return picks
    .filter(([, on]) => on)
    .map(([module]) => ({ module, config: SEED_DEFAULTS[module].config }));
}

/** Modules the headcount makes compulsory that the answers leave off - shown as a note, never blocks. */
export function compulsorySkipped(a: SetupAnswers): ('PF' | 'ESI')[] {
  const out: ('PF' | 'ESI')[] = [];
  if (!a.pf && isCompulsory('PF', a.employeeCount)) out.push('PF');
  if (!a.esi && isCompulsory('ESI', a.employeeCount)) out.push('ESI');
  return out;
}
