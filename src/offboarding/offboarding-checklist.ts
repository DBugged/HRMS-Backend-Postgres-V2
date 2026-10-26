// Purpose: the exit checklist as data - which items there are, who owns each and by when, and when a case is ready to complete.
// Responsibilities: pure rules (default owners and due dates, overdue, ready-to-complete, the wording of a waiting item) so the
//   service, the automation job and the tests all use one definition.
// Important: nothing here touches the database. A due date is a plain YYYY-MM-DD string, like the last working day.
export const CHECKLIST_ITEM_KEYS = ['assets', 'access', 'handover', 'interview'] as const;
export type ChecklistItemKey = (typeof CHECKLIST_ITEM_KEYS)[number];

export const CHECKLIST_ITEM_LABELS: Record<ChecklistItemKey, string> = {
  assets: 'All company assets returned',
  access: 'System / building access revoked',
  handover: 'Team handed over to a new manager',
  interview: 'Exit interview completed',
};

export interface ChecklistOwner {
  ownerId: string | null;
  dueDate: string | null;
}
export type ChecklistMeta = Partial<Record<ChecklistItemKey, ChecklistOwner>>;

/** Days before the last working day the checklist is due: leaves two working days for the settlement. */
export const CHECKLIST_DUE_DAYS_BEFORE_LWD = 2;

const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd}T00:00:00Z`) / 86400000);
const fromDayNumber = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);

/** Due date for the checklist: two days before the last working day, but never before today (an exit started late is due at once). */
export function defaultDueDate(lastWorkingDay: string, today: string): string {
  const due = fromDayNumber(dayNumber(lastWorkingDay) - CHECKLIST_DUE_DAYS_BEFORE_LWD);
  return due < today ? (lastWorkingDay < today ? lastWorkingDay : today) : due;
}

/**
 * Default owners when an exit starts: the person who started it (HR/Admin) owns assets, access and the interview; the leaver's
 * manager owns the team handover (the person who started it when there is none).
 */
export function defaultChecklistMeta(input: { initiatorId: string; managerId: string | null; lastWorkingDay: string; today: string }): ChecklistMeta {
  const dueDate = defaultDueDate(input.lastWorkingDay, input.today);
  const hr: ChecklistOwner = { ownerId: input.initiatorId, dueDate };
  return {
    assets: { ...hr },
    access: { ...hr },
    handover: { ownerId: input.managerId ?? input.initiatorId, dueDate },
    interview: { ...hr },
  };
}

export const isOverdue = (dueDate: string | null | undefined, today: string, done: boolean): boolean => !done && !!dueDate && dueDate < today;

export interface CaseState {
  assetsReturned: boolean;
  accessRevoked: boolean;
  interviewNeeded: boolean;
  exitInterviewDone: boolean;
  teamHandedOver: boolean;
  settlementPaid: boolean;
  settlementMatchesLastWorkingDay: boolean;
}

/** Which of the four checklist items are done for this case. */
export function itemsDone(c: CaseState): Record<ChecklistItemKey, boolean> {
  return {
    assets: c.assetsReturned,
    access: c.accessRevoked,
    handover: c.teamHandedOver,
    interview: !c.interviewNeeded || c.exitInterviewDone,
  };
}

/** Ready to complete: every checklist item done and the final settlement paid for this last working day. */
export function readyToComplete(c: CaseState): boolean {
  return Object.values(itemsDone(c)).every(Boolean) && c.settlementPaid && c.settlementMatchesLastWorkingDay;
}

/** What is still holding a case back, in the words HR reads. */
export function waitingFor(c: CaseState): string[] {
  const out: string[] = [];
  const done = itemsDone(c);
  for (const key of CHECKLIST_ITEM_KEYS) if (!done[key]) out.push(CHECKLIST_ITEM_LABELS[key]);
  if (!c.settlementPaid) out.push('Final settlement paid');
  else if (!c.settlementMatchesLastWorkingDay) out.push('Settlement matches the last working day');
  return out;
}

/**
 * The company's exit automation switches (Organization Settings > Policies). Preparing the final settlement draft by itself is
 * ON unless explicitly turned off; closing the case by itself once it is ready is OFF unless explicitly turned on.
 */
export function readExitAutomation(policies: unknown): { autoPrepareFnf: boolean; autoCompleteExit: boolean } {
  const p = (policies ?? {}) as { autoPrepareFnf?: unknown; autoCompleteExit?: unknown };
  return { autoPrepareFnf: p.autoPrepareFnf !== false, autoCompleteExit: p.autoCompleteExit === true };
}
