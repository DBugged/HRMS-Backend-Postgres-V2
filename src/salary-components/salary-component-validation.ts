import { CalcType } from '@prisma/client';
import { compileFormula, topoSortComponents } from './formula-engine';

export interface ComponentForCircularCheck {
  code: string;
  name: string;
  calcType: CalcType;
  percentageOf: string | null;
  formula: string | null;
}

/**
 * Pure port of the old salaryComponentController.js's
 * `assertNoCircularReferences`. Builds the org's full dependency graph
 * (PERCENTAGE -> percentageOf, FORMULA -> compiled referencedNames
 * filtered to known component codes) and runs it through
 * `topoSortComponents`, which throws on a cycle. Callers pass the
 * candidate (new-or-edited) row already overlaid into `components`, and
 * only `isActive` components — matching the old system's "an edit that
 * disables a component removes it from the graph" behavior.
 */
export function detectCircularReferences(
  components: ComponentForCircularCheck[],
): void {
  const byCode = new Map(components.map((c) => [c.code, c]));
  const edges: Record<string, string[]> = {};

  for (const component of components) {
    if (component.calcType === CalcType.PERCENTAGE) {
      edges[component.code] = component.percentageOf
        ? [component.percentageOf]
        : [];
    } else if (component.calcType === CalcType.FORMULA) {
      if (!component.formula) {
        edges[component.code] = [];
        continue;
      }
      let referencedNames: string[];
      try {
        referencedNames = compileFormula(component.formula).referencedNames;
      } catch (err) {
        throw new Error(
          `Invalid formula for "${component.name}": ${(err as Error).message}`,
        );
      }
      edges[component.code] = referencedNames.filter((name) =>
        byCode.has(name),
      );
    } else {
      edges[component.code] = [];
    }
  }

  topoSortComponents(edges);
}

export function isValidPercentage(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  );
}
