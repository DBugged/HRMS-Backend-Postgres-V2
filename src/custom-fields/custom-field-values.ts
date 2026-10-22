// Purpose: The rules for a company's own profile fields: making a key from a label, checking a definition, and checking
//   and merging the values an employee's record holds.
// Important: pure. A value is stored under its field's `key` as a string (text, long text, dropdown), a number, a
//   YYYY-MM-DD date string or a boolean. An empty value is not stored at all, so "not filled in" has one shape.
export const CUSTOM_FIELD_TYPES = ['TEXT', 'LONG_TEXT', 'NUMBER', 'DATE', 'DROPDOWN', 'CHECKBOX'] as const;
export type CustomFieldTypeName = (typeof CUSTOM_FIELD_TYPES)[number];

export const MAX_CUSTOM_FIELDS = 40;
export const MAX_DROPDOWN_OPTIONS = 50;
const MAX_TEXT = 500;
const MAX_LONG_TEXT = 2000;

export interface FieldDef {
  key: string;
  label: string;
  type: CustomFieldTypeName;
  options?: unknown;
  required: boolean;
  employeeEditable: boolean;
  isActive: boolean;
}

/** "Blood group" -> "blood_group": lower-case letters, digits and underscores. */
export function keyFromLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return slug || 'field';
}

/** The key to use for a new field: the label's key, with _2, _3 ... when it is already taken. */
export function uniqueKey(label: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = keyFromLabel(label);
  if (!used.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base.slice(0, 36)}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** The cleaned dropdown choices (trimmed, no blanks or repeats), or an error. */
export function cleanOptions(options: unknown): { options: string[] } | { error: string } {
  if (!Array.isArray(options)) return { error: 'A dropdown needs a list of choices.' };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of options) {
    if (typeof raw !== 'string') return { error: 'Every choice must be text.' };
    const v = raw.trim();
    if (!v) continue;
    if (v.length > 100) return { error: 'A choice can be at most 100 characters.' };
    const lower = v.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(v);
  }
  if (out.length < 2) return { error: 'Give a dropdown at least two different choices.' };
  if (out.length > MAX_DROPDOWN_OPTIONS) return { error: `A dropdown can have at most ${MAX_DROPDOWN_OPTIONS} choices.` };
  return { options: out };
}

const isRealDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const isBlank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** One value checked against its field: the value to store (null = nothing stored), or a message. */
export function checkValue(def: FieldDef, value: unknown): { value: string | number | boolean | null } | { error: string } {
  if (isBlank(value)) {
    // A checkbox that is false is a real answer, but "not ticked" and "never answered" are stored the same way.
    return def.required ? { error: `${def.label} is required.` } : { value: null };
  }
  switch (def.type) {
    case 'TEXT':
    case 'LONG_TEXT': {
      if (typeof value !== 'string') return { error: `${def.label} must be text.` };
      const v = value.trim();
      const max = def.type === 'TEXT' ? MAX_TEXT : MAX_LONG_TEXT;
      if (v.length > max) return { error: `${def.label} can be at most ${max} characters.` };
      return { value: v };
    }
    case 'NUMBER': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
      if (!Number.isFinite(n)) return { error: `${def.label} must be a number.` };
      return { value: n };
    }
    case 'DATE': {
      if (typeof value !== 'string' || !isRealDate(value.trim())) return { error: `${def.label} must be a date (DD-MM-YYYY).` };
      return { value: value.trim() };
    }
    case 'DROPDOWN': {
      const choices = Array.isArray(def.options) ? (def.options as string[]) : [];
      if (typeof value !== 'string' || !choices.includes(value)) return { error: `${def.label}: pick one of the listed choices.` };
      return { value };
    }
    case 'CHECKBOX': {
      if (typeof value !== 'boolean') return { error: `${def.label} must be yes or no.` };
      // Not ticked is stored as nothing - and a required checkbox (an acknowledgement) must be ticked.
      if (!value) return def.required ? { error: `${def.label} must be ticked.` } : { value: null };
      return { value: true };
    }
  }
}

export interface MergeResult {
  /** The employee's values after the change. */
  values: Record<string, string | number | boolean>;
  /** Keys whose value changed (never the values themselves - those may be personal). */
  changedKeys: string[];
  errors: string[];
}

/**
 * Applies `incoming` ({ key: value }) to the employee's `current` values. An unknown or switched-off field is refused,
 * and a person who is not HR/Admin can only change the fields marked employee-editable. Only the keys in `incoming`
 * are touched; the rest keep their value.
 */
export function mergeValues(
  defs: FieldDef[],
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
  actor: { canEditAll: boolean },
): MergeResult {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const values: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(current)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') values[k] = v;
  }
  const errors: string[] = [];
  const changedKeys: string[] = [];
  for (const [key, raw] of Object.entries(incoming)) {
    const def = byKey.get(key);
    if (!def || !def.isActive) {
      errors.push(`There is no active field "${key}".`);
      continue;
    }
    if (!actor.canEditAll && !def.employeeEditable) {
      errors.push(`${def.label} can only be changed by HR.`);
      continue;
    }
    const checked = checkValue(def, raw);
    if ('error' in checked) {
      errors.push(checked.error);
      continue;
    }
    const before = values[key];
    if (checked.value === null) delete values[key];
    else values[key] = checked.value;
    if (before !== checked.value && !(before === undefined && checked.value === null)) changedKeys.push(key);
  }
  return { values, changedKeys, errors };
}
