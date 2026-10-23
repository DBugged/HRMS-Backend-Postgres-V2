// Purpose: one line per statutory module for the Statutory Compliance Center's tab bar: is the rule in force today, and is a change
//   already scheduled for a later date.
// Important: pure (no DB). "In force" mirrors StatutoryConfigService.getEffective: the newest version that has started and not ended.
//   Dates are plain YYYY-MM-DD strings, compared as text, like everywhere else in statutory config.
export interface VersionRow {
  module: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  isEnabled: boolean;
}

export interface ModuleSummary {
  /** The rule is switched on in the version in force today. */
  enabled: boolean;
  /** The first later date a new version starts (a rate change, or switching on/off); null when none is scheduled. */
  nextChangeOn: string | null;
}

export function summariseModules(modules: string[], versions: VersionRow[], today: string): Record<string, ModuleSummary> {
  const out: Record<string, ModuleSummary> = {};
  for (const m of modules) {
    const mine = versions.filter((v) => v.module === m);
    const inForce = mine
      .filter((v) => v.effectiveFrom <= today && (v.effectiveTo === null || v.effectiveTo >= today))
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    const later = mine.map((v) => v.effectiveFrom).filter((d) => d > today).sort()[0] ?? null;
    out[m.toLowerCase()] = { enabled: !!inForce?.isEnabled, nextChangeOn: later };
  }
  return out;
}
