import {
  checkValue,
  cleanOptions,
  keyFromLabel,
  mergeValues,
  uniqueKey,
  type FieldDef,
} from './custom-field-values';

const def = (over: Partial<FieldDef> = {}): FieldDef => ({
  key: 'blood_group',
  label: 'Blood group',
  type: 'DROPDOWN',
  options: ['A+', 'B+', 'O+'],
  required: false,
  employeeEditable: false,
  isActive: true,
  ...over,
});

describe('custom field keys', () => {
  it('turns a label into a safe key', () => {
    expect(keyFromLabel('Blood group')).toBe('blood_group');
    expect(keyFromLabel("  T-Shirt size (M/L)! ")).toBe('t_shirt_size_m_l');
    expect(keyFromLabel('###')).toBe('field');
  });
  it('adds a number when the key is taken', () => {
    expect(uniqueKey('Blood group', ['blood_group'])).toBe('blood_group_2');
    expect(uniqueKey('Blood group', ['blood_group', 'blood_group_2'])).toBe('blood_group_3');
    expect(uniqueKey('Blood group', [])).toBe('blood_group');
  });
});

describe('cleanOptions', () => {
  it('trims, drops blanks and repeats, and needs two choices', () => {
    expect(cleanOptions([' A+ ', 'a+', '', 'B+'])).toEqual({ options: ['A+', 'B+'] });
    expect('error' in cleanOptions(['only'])).toBe(true);
    expect('error' in cleanOptions('nope')).toBe(true);
  });
});

describe('checkValue', () => {
  it('stores nothing for a blank, unless the field is required', () => {
    expect(checkValue(def(), '')).toEqual({ value: null });
    expect(checkValue(def({ required: true }), null)).toEqual({ error: 'Blood group is required.' });
  });
  it('checks each type', () => {
    expect(checkValue(def({ type: 'NUMBER', label: 'Age' }), '42')).toEqual({ value: 42 });
    expect('error' in checkValue(def({ type: 'NUMBER' }), 'abc')).toBe(true);
    expect(checkValue(def({ type: 'DATE' }), '2026-02-28')).toEqual({ value: '2026-02-28' });
    expect('error' in checkValue(def({ type: 'DATE' }), '2026-02-30')).toBe(true);
    expect('error' in checkValue(def({ type: 'DATE' }), '28-02-2026')).toBe(true);
    expect(checkValue(def(), 'O+')).toEqual({ value: 'O+' });
    expect('error' in checkValue(def(), 'Z+')).toBe(true);
    expect(checkValue(def({ type: 'CHECKBOX' }), true)).toEqual({ value: true });
    expect(checkValue(def({ type: 'CHECKBOX' }), false)).toEqual({ value: null });
    expect('error' in checkValue(def({ type: 'CHECKBOX', required: true }), false)).toBe(true);
    expect('error' in checkValue(def({ type: 'TEXT' }), 'x'.repeat(501))).toBe(true);
  });
});

describe('mergeValues', () => {
  const defs = [def(), def({ key: 'vehicle_no', label: 'Vehicle number', type: 'TEXT', employeeEditable: true })];

  it('changes only the fields sent and reports which ones changed', () => {
    const r = mergeValues(defs, { blood_group: 'A+', vehicle_no: 'KA01' }, { vehicle_no: 'KA02' }, { canEditAll: true });
    expect(r.errors).toEqual([]);
    expect(r.values).toEqual({ blood_group: 'A+', vehicle_no: 'KA02' });
    expect(r.changedKeys).toEqual(['vehicle_no']);
  });

  it('lets an employee change only the fields marked employee-editable', () => {
    const r = mergeValues(defs, {}, { blood_group: 'O+', vehicle_no: 'KA01' }, { canEditAll: false });
    expect(r.errors).toEqual(['Blood group can only be changed by HR.']);
    expect(r.values).toEqual({ vehicle_no: 'KA01' });
  });

  it('refuses a field that does not exist or is switched off', () => {
    const r = mergeValues([def({ isActive: false })], {}, { blood_group: 'O+', nope: 'x' }, { canEditAll: true });
    expect(r.errors).toHaveLength(2);
    expect(r.values).toEqual({});
  });

  it('removes a value that is cleared', () => {
    const r = mergeValues(defs, { vehicle_no: 'KA01' }, { vehicle_no: '' }, { canEditAll: true });
    expect(r.values).toEqual({});
    expect(r.changedKeys).toEqual(['vehicle_no']);
  });

  it('does not count a repeat of the same value as a change', () => {
    const r = mergeValues(defs, { vehicle_no: 'KA01' }, { vehicle_no: 'KA01' }, { canEditAll: true });
    expect(r.changedKeys).toEqual([]);
  });
});
