// Purpose: the joining checklist as data - which steps a new joiner has, who owns each and by when, and which the system can
//   tick by itself.
// Responsibilities: pure rules (the step list, default owners and due dates, what counts as done, overdue) so the service, the
//   daily job and the tests share one definition. Mirrors the exit checklist (offboarding-checklist.ts) for the other end of a stay.
// Important: nothing here touches the database. Dates are plain YYYY-MM-DD strings.
export const JOINING_ITEM_KEYS = ['assets', 'workEmail', 'idCard', 'documents', 'profile', 'introduction'] as const;
export type JoiningItemKey = (typeof JOINING_ITEM_KEYS)[number];

export const JOINING_ITEM_LABELS: Record<JoiningItemKey, string> = {
  assets: 'Laptop and other assets handed over',
  workEmail: 'Work email and system access set up',
  idCard: 'ID card / access card issued',
  documents: 'Joining documents uploaded',
  profile: 'Profile completed',
  introduction: 'Introduced to the team',
};

/** Steps the system ticks by itself from what it can see; the rest are ticked by their owner. */
export const AUTO_ITEM_KEYS: readonly JoiningItemKey[] = ['assets', 'documents', 'profile'];

/** Days from the joining date a step is due. Setup steps are due on the first day; the joiner's own steps in the first week. */
const DUE_OFFSET_DAYS: Record<JoiningItemKey, number> = { assets: 0, workEmail: 0, idCard: 1, documents: 7, profile: 7, introduction: 1 };

export interface JoiningMetaItem {
  ownerId: string | null;
  dueDate: string | null;
  doneAt: string | null;
  doneById: string | null;
}
export type JoiningMeta = Partial<Record<JoiningItemKey, JoiningMetaItem>>;

const dayNumber = (ymd: string) => Math.round(Date.parse(`${ymd.slice(0, 10)}T00:00:00Z`) / 86400000);
const fromDayNumber = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);

/** Due date for a step: the joining date plus the step's offset, but never before today (someone added late is due at once). */
export function dueDateFor(key: JoiningItemKey, joiningDate: string, today: string): string {
  const due = fromDayNumber(dayNumber(joiningDate) + DUE_OFFSET_DAYS[key]);
  return due < today ? today : due;
}

/**
 * The starting owners and dates for a new joiner. HR owns the setup steps (assets, work email, ID card); the joiner's reporting
 * manager owns the introduction (HR when there is none). The joiner's own steps (documents, profile) have no owner - the system
 * ticks them and the joiner is the one to act.
 */
export function defaultJoiningMeta(input: { hrId: string | null; managerId: string | null; joiningDate: string; today: string }): JoiningMeta {
  const item = (key: JoiningItemKey, ownerId: string | null): JoiningMetaItem => ({
    ownerId,
    dueDate: dueDateFor(key, input.joiningDate, input.today),
    doneAt: null,
    doneById: null,
  });
  return {
    assets: item('assets', input.hrId),
    workEmail: item('workEmail', input.hrId),
    idCard: item('idCard', input.hrId),
    documents: item('documents', null),
    profile: item('profile', null),
    introduction: item('introduction', input.managerId ?? input.hrId),
  };
}

export interface JoiningFacts {
  hasAllocatedAsset: boolean;
  documentsUploaded: boolean;
  profileCompleted: boolean;
}

/** Whether each step is done: ticked by its owner, or (for the system's steps) seen from the facts. */
export function joiningDone(meta: JoiningMeta, facts: JoiningFacts): Record<JoiningItemKey, boolean> {
  const manual = (key: JoiningItemKey) => !!meta[key]?.doneAt;
  return {
    assets: manual('assets') || facts.hasAllocatedAsset,
    workEmail: manual('workEmail'),
    idCard: manual('idCard'),
    documents: manual('documents') || facts.documentsUploaded,
    profile: manual('profile') || facts.profileCompleted,
    introduction: manual('introduction'),
  };
}

export const isJoiningOverdue = (dueDate: string | null | undefined, today: string, done: boolean): boolean => !done && !!dueDate && dueDate < today;

/** Whether a joiner still gets a checklist: joined up to `LOOKBACK` days ago, or joins within `LOOKAHEAD` days. */
export const JOINING_LOOKBACK_DAYS = 30;
export const JOINING_LOOKAHEAD_DAYS = 30;
export function needsJoiningChecklist(joiningDate: string, today: string): boolean {
  const d = dayNumber(joiningDate) - dayNumber(today);
  return d >= -JOINING_LOOKBACK_DAYS && d <= JOINING_LOOKAHEAD_DAYS;
}
