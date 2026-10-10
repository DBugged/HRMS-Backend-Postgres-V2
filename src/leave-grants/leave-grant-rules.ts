// Purpose: Pure rules for granting event-based leave — no DB access, so every rule is directly unit-testable.
// Important: nothing here branches on a leave type's name or code; behaviour comes from the type's configuration
//   (allocationType EVENT_BASED, annualQuota as the maximum per event, and the eventGrant settings).
import { AllocationType } from '@prisma/client';

export interface EventGrantConfig {
  unit: 'CALENDAR_DAYS' | 'WORKING_DAYS';
  repeatPolicy: 'ONCE_PER_EVENT' | 'MIN_INTERVAL';
  minIntervalMonths: number;
  effectiveFrom: string | null;
}

export function readEventGrantConfig(raw: unknown): EventGrantConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  return {
    unit: c.unit === 'WORKING_DAYS' ? 'WORKING_DAYS' : 'CALENDAR_DAYS',
    repeatPolicy:
      c.repeatPolicy === 'MIN_INTERVAL' ? 'MIN_INTERVAL' : 'ONCE_PER_EVENT',
    minIntervalMonths:
      typeof c.minIntervalMonths === 'number' && c.minIntervalMonths > 0
        ? c.minIntervalMonths
        : 0,
    effectiveFrom:
      typeof c.effectiveFrom === 'string' && c.effectiveFrom
        ? c.effectiveFrom
        : null,
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function addMonths(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

export interface GrantRuleInput {
  eventDate: string;
  effectiveDate: string;
  days: number;
  documentRef?: string | null;
}

export interface GrantRuleType {
  isActive: boolean;
  allocationType: AllocationType;
  annualQuota: number;
  documentsRequired: boolean;
  eventGrant: unknown;
}

/** Returns the first problem with a grant request, or null when it may go ahead. */
export function checkGrantRequest(
  leaveType: GrantRuleType,
  input: GrantRuleInput,
  activeGrantEventDates: string[],
): string | null {
  if (leaveType.allocationType !== AllocationType.EVENT_BASED) {
    return 'This leave type is not event-based, so it cannot be granted per event.';
  }
  if (!leaveType.isActive) return 'This leave type is inactive.';
  if (!ISO_DATE.test(input.eventDate) || !ISO_DATE.test(input.effectiveDate)) {
    return 'Enter the event date and the effective date as valid dates.';
  }
  if (!Number.isFinite(input.days) || input.days <= 0) {
    return 'The granted days must be more than zero.';
  }
  if (leaveType.annualQuota > 0 && input.days > leaveType.annualQuota) {
    return `The granted days cannot exceed the policy maximum of ${leaveType.annualQuota} per event.`;
  }
  const cfg = readEventGrantConfig(leaveType.eventGrant);
  if (cfg.effectiveFrom && input.effectiveDate < cfg.effectiveFrom) {
    return `This leave type can only be granted from ${cfg.effectiveFrom}.`;
  }
  if (leaveType.documentsRequired && !input.documentRef?.trim()) {
    return 'Supporting document or eligibility confirmation is required for this leave type.';
  }
  if (activeGrantEventDates.includes(input.eventDate)) {
    return 'A grant already exists for this employee, leave type and event date.';
  }
  if (cfg.repeatPolicy === 'MIN_INTERVAL' && cfg.minIntervalMonths > 0) {
    for (const prior of activeGrantEventDates) {
      const earliestNext = addMonths(prior, cfg.minIntervalMonths);
      const earliestThis = addMonths(input.eventDate, cfg.minIntervalMonths);
      if (input.eventDate < earliestNext && prior < earliestThis) {
        return `Another grant exists for an event on ${prior}; the next event must be at least ${cfg.minIntervalMonths} month(s) apart.`;
      }
    }
  }
  return null;
}
