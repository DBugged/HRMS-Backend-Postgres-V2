// Purpose: Turn a package (annual CTC, or a monthly gross) into a salary structure that follows the Labour Codes, for the
//   salary-structure builder: Basic is half of the total package, HRA follows where the employee is hired (50% of Basic
//   in a metro city, 40% elsewhere, none by default in a village), chosen allowances keep their amounts and the Special
//   Allowance takes the balance.
// Responsibilities: solve for the figures, and say what the employer pays on top (PF, EDLI, admin, ESI, gratuity, bonus
//   accrual, NPS) so the CTC adds up. Returns the lines the structure is saved with.
// Important: pure, and it runs the SAME component resolver and statutory wage bases payroll runs (resolve-group.ts,
//   formula-context.ts), so a previewed CTC is what payroll will show. Not every employer cost is in a month: LWF falls
//   in June and December only, so it is left out and noted.
import {
  CalcType,
  PayFrequency,
  SalaryComponentType,
  type EmployeeSalaryComponent,
  type SalaryComponent,
} from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { defaultHraPercent, type CityClassName } from '../common/hra-cities';
import { buildBaseContext, deriveStatutoryContext } from './formula-context';
import { computeAttendanceSummary } from './attendance-summary';
import { isComponentApplicable, resolveGroup } from './resolve-group';
import type { OverlaidSettings } from './statutory-overlay';
import {
  statutoryDefaultsForType,
  type StatutoryDefaults,
} from './employee-type-statutory';

export interface StructurePreviewInput {
  /** CTC: an annual package. GROSS: a monthly gross. */
  mode: 'CTC' | 'GROSS';
  annualCtc?: number;
  monthlyGross?: number;
  /** Variable pay for the year, paid on top of the fixed package (not part of the monthly figures). */
  variableAnnual?: number;
  cityClass: CityClassName;
  employeeType?: string;
  /** Basic as a percentage of the total monthly package. Default 50, the Labour Codes' wages rule. */
  basicPercent?: number;
  hra?: { enabled?: boolean; percent?: number };
  da?: { enabled?: boolean; amount?: number };
  /** Fixed monthly allowances that are switched on: component code -> monthly amount. */
  allowances?: Record<string, number>;
  /** Which schemes apply; absent = the defaults of the employee type. */
  statutory?: Partial<StatutoryDefaults> & { nps?: boolean };
}

export interface PreviewLine {
  code: string;
  name: string;
  monthly: number;
  annual: number;
  note?: string;
}

export interface StructureLineToSave {
  componentCode: string;
  valueType: 'FIXED' | 'MANUAL' | 'PERCENTAGE';
  fixedAmount?: number;
  percentageValue?: number;
  percentageOf?: string;
  amountBasis?: 'MONTHLY' | 'ANNUAL';
  isEnabled: boolean;
}

export interface StructurePreview {
  earnings: PreviewLine[];
  employer: PreviewLine[];
  grossMonthly: number;
  employerMonthly: number;
  ctcMonthly: number;
  ctcAnnual: number;
  variableAnnual: number;
  totalAnnual: number;
  /** (Basic + DA) as a percentage of the total monthly package. */
  wagesPercent: number;
  statutory: StatutoryDefaults & { nps: boolean };
  /** Which schemes the organisation has switched on at all (Statutory Configuration); a scheme that is off there cannot apply. */
  available: StatutoryDefaults & { nps: boolean };
  hraPercent: number;
  lines: StructureLineToSave[];
  warnings: string[];
  notes: string[];
}

const PF_CODES = ['PF', 'PF_EMPLOYER', 'EDLI_EMPLOYER', 'EPF_ADMIN_EMPLOYER'];
const ESI_CODES = ['ESI', 'ESI_EMPLOYER'];
const SCHEME_CODES: Record<string, string[]> = {
  pf: PF_CODES,
  esi: ESI_CODES,
  gratuity: ['GRATUITY_ACCRUAL'],
  bonus: ['BONUS_ACCRUAL'],
  nps: ['NPS', 'NPS_EMPLOYER'],
};
// A month with no Labour Welfare Fund instalment (it falls in June and December only).
const PREVIEW_MONTH = 1;
const PREVIEW_YEAR = 2027;

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function override(
  componentCode: string,
  partial: Partial<EmployeeSalaryComponent>,
): EmployeeSalaryComponent {
  return {
    componentCode,
    valueType: CalcType.FIXED,
    fixedAmount: null,
    percentageValue: null,
    percentageOf: null,
    formula: null,
    amountBasis: 'MONTHLY',
    isEnabled: true,
    ...partial,
  } as unknown as EmployeeSalaryComponent;
}

export function computeStructurePreview(args: {
  input: StructurePreviewInput;
  components: SalaryComponent[];
  settings: OverlaidSettings;
}): StructurePreview {
  const { input, settings } = args;
  const components = args.components.filter((c) => c.isActive);
  const has = (code: string) => components.some((c) => c.code === code);
  if (!has('BASIC')) {
    throw new BadRequestException('There is no active Basic component.');
  }
  const warnings: string[] = [];
  const notes: string[] = [];

  const typeDefaults = statutoryDefaultsForType(input.employeeType);
  const statutory = {
    pf: input.statutory?.pf ?? typeDefaults.pf,
    esi: input.statutory?.esi ?? typeDefaults.esi,
    gratuity: input.statutory?.gratuity ?? typeDefaults.gratuity,
    bonus: input.statutory?.bonus ?? typeDefaults.bonus,
    nps: input.statutory?.nps ?? false,
  };

  const basicPercent = Math.min(
    100,
    Math.max(0, num(input.basicPercent ?? 50)),
  );
  if (basicPercent < 50) {
    warnings.push(
      `Basic is ${basicPercent}% of the package. The Labour Codes want Basic + DA to be at least 50% of total remuneration; PF and gratuity are charged on the higher of the two.`,
    );
  }
  const hraEnabled =
    has('HRA') && (input.hra?.enabled ?? input.cityClass !== 'RURAL');
  const hraPercent = hraEnabled
    ? num(input.hra?.percent ?? defaultHraPercent(input.cityClass))
    : 0;
  const daEnabled = has('DA') && !!input.da?.enabled;
  const daAmount = daEnabled
    ? Math.max(0, Math.round(num(input.da?.amount)))
    : 0;
  const allowances = Object.entries(input.allowances ?? {})
    .filter(([code]) => has(code) && code !== 'BASIC' && code !== 'HRA')
    .map(
      ([code, amount]) => [code, Math.max(0, Math.round(num(amount)))] as const,
    );
  const allowancesTotal = allowances.reduce((s, [, a]) => s + a, 0);
  const hasSpecial = has('SPECIAL_ALLOWANCE');

  const target =
    input.mode === 'CTC' ? num(input.annualCtc) / 12 : num(input.monthlyGross);
  if (!(target > 0)) {
    throw new BadRequestException(
      input.mode === 'CTC'
        ? 'Enter the annual CTC.'
        : 'Enter the monthly gross.',
    );
  }

  const attendance = computeAttendanceSummary(
    [],
    [],
    [],
    PREVIEW_MONTH,
    PREVIEW_YEAR,
  );
  attendance.payableDays = attendance.totalDaysInMonth;
  attendance.presentDays = attendance.totalDaysInMonth;
  attendance.workingDays = attendance.totalDaysInMonth;
  const base = buildBaseContext(attendance, settings, PREVIEW_MONTH, {
    state: null,
    gender: null,
    lwfExempt: true,
  });

  const build = (basic: number, special: number) => {
    const hra = hraEnabled ? Math.round((basic * hraPercent) / 100) : 0;
    const overrides = new Map<string, EmployeeSalaryComponent>();
    overrides.set('BASIC', override('BASIC', { fixedAmount: basic }));
    if (daEnabled)
      overrides.set('DA', override('DA', { fixedAmount: daAmount }));
    if (has('HRA')) {
      overrides.set(
        'HRA',
        hraEnabled
          ? override('HRA', {
              valueType: CalcType.PERCENTAGE,
              percentageValue: hraPercent,
              percentageOf: 'BASIC',
            })
          : override('HRA', { isEnabled: false }),
      );
    }
    for (const [code, amount] of allowances) {
      overrides.set(code, override(code, { fixedAmount: amount }));
    }
    if (hasSpecial) {
      overrides.set(
        'SPECIAL_ALLOWANCE',
        override('SPECIAL_ALLOWANCE', { fixedAmount: Math.max(0, special) }),
      );
    }
    for (const [scheme, codes] of Object.entries(SCHEME_CODES)) {
      if (statutory[scheme as keyof typeof statutory]) continue;
      for (const code of codes) {
        if (has(code))
          overrides.set(code, override(code, { isEnabled: false }));
      }
    }

    const earningComponents = components.filter(
      (c) =>
        c.type === SalaryComponentType.EARNING &&
        !c.isEmployerContribution &&
        c.payFrequency === PayFrequency.MONTHLY &&
        isComponentApplicable(
          c,
          overrides.get(c.code) ?? null,
          PREVIEW_MONTH,
          settings,
        ),
    );
    const earned = resolveGroup(
      earningComponents,
      overrides,
      base,
      1,
      Math.round,
    );
    const gross = earned.results.reduce((s, l) => s + Math.round(l.amount), 0);

    const afterEarnings: Record<string, number> = { ...base };
    for (const line of earned.results) {
      afterEarnings[line.code] = Math.round(line.amount);
    }
    afterEarnings.GROSS_EARNINGS = gross;
    afterEarnings.ESI_WAGES = gross;
    afterEarnings.FULL_MONTH_ESI_WAGES = gross;
    afterEarnings.FULL_MONTH_BASIC_DA =
      (afterEarnings.BASIC ?? 0) + (afterEarnings.DA ?? 0);
    Object.assign(
      afterEarnings,
      deriveStatutoryContext(afterEarnings, settings, false),
    );
    if (settings.pfOnActualWages && settings.pfEnabled) {
      afterEarnings.PF_WAGE_CEILING = Math.max(
        afterEarnings.PF_WAGES ?? 0,
        settings.pfWageCeiling,
      );
    }
    const employerComponents = components.filter(
      (c) =>
        c.isEmployerContribution &&
        c.type === SalaryComponentType.EARNING &&
        isComponentApplicable(
          c,
          overrides.get(c.code) ?? null,
          PREVIEW_MONTH,
          settings,
        ),
    );
    const employer = resolveGroup(
      employerComponents,
      overrides,
      { ...afterEarnings, TOTAL_DEDUCTIONS: 0 },
      1,
      Math.round,
    );
    const employerLines = employer.results
      .map((l) => ({
        code: l.code,
        name: l.name,
        amount: Math.round(l.amount),
      }))
      .filter((l) => l.amount > 0);
    return {
      hra,
      overrides,
      earnedLines: earned.results.map((l) => ({
        code: l.code,
        name: l.name,
        amount: Math.round(l.amount),
      })),
      gross,
      employerLines,
      employerTotal: employerLines.reduce((s, l) => s + l.amount, 0),
    };
  };

  // Solve: the package is gross + the employer's contributions, and those depend on Basic and on gross, so iterate.
  let basic = 0;
  let special = 0;
  let result = build(0, 0);
  let ctcMonthly = target;
  let gross = input.mode === 'GROSS' ? target : target * 0.85;
  for (let i = 0; i < 20; i += 1) {
    const total =
      input.mode === 'CTC' ? target : gross + (result.employerTotal || 0);
    ctcMonthly = total;
    basic = Math.max(0, Math.round((total * basicPercent) / 100 - daAmount));
    const hra = hraEnabled ? Math.round((basic * hraPercent) / 100) : 0;
    special = Math.round(gross - basic - daAmount - hra - allowancesTotal);
    result = build(basic, hasSpecial ? special : 0);
    const nextGross =
      input.mode === 'CTC'
        ? Math.round(target - result.employerTotal)
        : Math.round(target);
    if (nextGross === gross && i > 0) break;
    gross = nextGross;
  }
  const finalGross = result.gross;
  if (special < 0) {
    warnings.push(
      `Basic, HRA and the chosen allowances already come to more than the package, by ₹${Math.abs(special).toLocaleString('en-IN')} a month. Untick an allowance or lower an amount.`,
    );
  }
  if (!hasSpecial && Math.abs(finalGross - gross) > 1) {
    warnings.push(
      'There is no Special Allowance component to take the balance, so the total does not match the package exactly.',
    );
  }
  const employerMonthly = result.employerTotal;
  const ctcMonthlyRounded = finalGross + employerMonthly;
  const variableAnnual = Math.max(0, Math.round(num(input.variableAnnual)));
  if (input.cityClass === 'RURAL' && hraEnabled) {
    notes.push('HRA is switched on for a village location by choice.');
  }
  if (!hraEnabled && has('HRA')) {
    notes.push(
      input.cityClass === 'RURAL'
        ? 'No HRA for a village location (it can be ticked on).'
        : 'HRA is not part of this structure.',
    );
  }
  if (!statutory.pf) notes.push('PF does not apply to this employee.');
  if (
    statutory.esi &&
    result.earnedLines.reduce((s, l) => s + l.amount, 0) >
      settings.esiWageCeiling
  ) {
    notes.push(
      `Gross is above ₹${settings.esiWageCeiling.toLocaleString('en-IN')}, so ESI does not apply.`,
    );
  }
  notes.push(
    'Labour Welfare Fund (June and December) is not in the monthly figures.',
  );

  const lines: StructureLineToSave[] = [];
  lines.push({
    componentCode: 'BASIC',
    valueType: 'FIXED',
    fixedAmount: basic,
    amountBasis: 'MONTHLY',
    isEnabled: true,
  });
  if (has('DA')) {
    lines.push({
      componentCode: 'DA',
      valueType: 'FIXED',
      fixedAmount: daAmount,
      amountBasis: 'MONTHLY',
      isEnabled: daEnabled,
    });
  }
  if (has('HRA')) {
    lines.push(
      hraEnabled
        ? {
            componentCode: 'HRA',
            valueType: 'PERCENTAGE',
            percentageValue: hraPercent,
            percentageOf: 'BASIC',
            isEnabled: true,
          }
        : {
            componentCode: 'HRA',
            valueType: 'FIXED',
            fixedAmount: 0,
            isEnabled: false,
          },
    );
  }
  for (const [code, amount] of allowances) {
    lines.push({
      componentCode: code,
      valueType: 'FIXED',
      fixedAmount: amount,
      amountBasis: 'MONTHLY',
      isEnabled: true,
    });
  }
  if (hasSpecial) {
    lines.push({
      componentCode: 'SPECIAL_ALLOWANCE',
      valueType: 'FIXED',
      fixedAmount: Math.max(0, special),
      amountBasis: 'MONTHLY',
      isEnabled: true,
    });
  }
  // A scheme that does not apply is switched off for this employee, so payroll skips it.
  for (const [scheme, codes] of Object.entries(SCHEME_CODES)) {
    if (statutory[scheme as keyof typeof statutory]) continue;
    for (const code of codes) {
      if (has(code)) {
        lines.push({
          componentCode: code,
          valueType: 'FIXED',
          fixedAmount: 0,
          isEnabled: false,
        });
      }
    }
  }
  if (variableAnnual > 0 && has('VARIABLE_PAY')) {
    lines.push({
      componentCode: 'VARIABLE_PAY',
      valueType: 'MANUAL',
      fixedAmount: variableAnnual,
      amountBasis: 'ANNUAL',
      isEnabled: true,
    });
  }

  // A line that comes to nothing (Overtime Pay, which is paid for hours worked) is not part of a package.
  const earningsOut: PreviewLine[] = result.earnedLines
    .filter((l) => l.amount > 0 || l.code === 'BASIC')
    .map((l) => ({
      code: l.code,
      name: l.name,
      monthly: l.amount,
      annual: l.amount * 12,
      ...(l.code === 'HRA' ? { note: `${hraPercent}% of Basic` } : {}),
      ...(l.code === 'BASIC'
        ? { note: `${basicPercent}% of the package` }
        : {}),
    }));
  const employerOut: PreviewLine[] = result.employerLines.map((l) => ({
    code: l.code,
    name: l.name,
    monthly: l.amount,
    annual: l.amount * 12,
  }));
  const wagesBase =
    (result.earnedLines.find((l) => l.code === 'BASIC')?.amount ?? 0) +
    (result.earnedLines.find((l) => l.code === 'DA')?.amount ?? 0);
  void ctcMonthly;
  return {
    earnings: earningsOut,
    employer: employerOut,
    grossMonthly: finalGross,
    employerMonthly,
    ctcMonthly: ctcMonthlyRounded,
    ctcAnnual: ctcMonthlyRounded * 12,
    variableAnnual,
    totalAnnual: ctcMonthlyRounded * 12 + variableAnnual,
    wagesPercent:
      ctcMonthlyRounded > 0
        ? Math.round((wagesBase / ctcMonthlyRounded) * 1000) / 10
        : 0,
    statutory,
    available: {
      pf: !!settings.pfEnabled,
      esi: !!settings.esiEnabled,
      gratuity: !!settings.gratuityEnabled,
      bonus: !!settings.bonusEnabled,
      nps: !!settings.npsEnabled,
    },
    hraPercent,
    lines,
    warnings,
    notes,
  };
}
