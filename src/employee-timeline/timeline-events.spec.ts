import { EVENT_META, TIMELINE_CATEGORIES } from './timeline-events';

describe('EVENT_META', () => {
  it('every event maps to a category present in TIMELINE_CATEGORIES', () => {
    const validCategories = new Set(TIMELINE_CATEGORIES.map((c) => c.value));
    for (const [key, meta] of Object.entries(EVENT_META)) {
      expect(validCategories.has(meta.category)).toBe(true);
      expect(meta.title.length).toBeGreaterThan(0);
      expect(key).toMatch(/^[A-Z_]+$/);
    }
  });

  it('has an entry for a representative event from each category', () => {
    expect(EVENT_META.EMPLOYEE_RECORD_CREATED.category).toBe('RECRUITMENT');
    expect(EVENT_META.PROBATION_STARTED.category).toBe('EMPLOYMENT');
    expect(EVENT_META.DEPARTMENT_CHANGED.category).toBe('ORGANIZATION');
    expect(EVENT_META.PAYROLL_PROCESSED.category).toBe('PAYROLL');
    expect(EVENT_META.LEAVE_APPROVED.category).toBe('ATTENDANCE_LEAVE');
    expect(EVENT_META.PROMOTION.category).toBe('PERFORMANCE');
    expect(EVENT_META.PAN_UPDATED.category).toBe('COMPLIANCE');
    expect(EVENT_META.RELIEVED.category).toBe('EXIT');
  });

  it('has exactly 8 categories', () => {
    expect(TIMELINE_CATEGORIES).toHaveLength(8);
  });
});
