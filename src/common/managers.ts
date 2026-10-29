// Purpose: one place that knows an employee can have several reporting managers: the primary (User.reportingManagerId) and
//   any additional ones (User.additionalReportingManagerIds). Every "is this person my report?" / "who do I tell?" check goes
//   through here so the primary and the extra managers always behave the same.
// Important: the primary manager is still what the org chart, the profile header and old clients show; the extras are
//   additive (they can approve and are notified) - nothing that worked with one manager changes.
export interface HasManagers {
  reportingManagerId?: string | null;
  additionalReportingManagerIds?: string[] | null;
}

/** Every manager id of an employee, primary first, without duplicates or blanks. */
export const managerIdsOf = (e: HasManagers): string[] => [
  ...new Set([e.reportingManagerId, ...(e.additionalReportingManagerIds ?? [])].filter((x): x is string => !!x)),
];

/** True when `managerId` is the employee's primary or one of the additional managers. */
export const isManagerOf = (managerId: string, e: HasManagers): boolean => managerIdsOf(e).includes(managerId);

/** Prisma filter for "people who report to this manager, as primary or additional". */
export const reportsToWhere = (managerId: string) => ({
  OR: [{ reportingManagerId: managerId }, { additionalReportingManagerIds: { has: managerId } }],
});

/** The ids to store from a picked list: the first is the primary, the rest are additional. Order and duplicates are tidied. */
export function splitManagerIds(picked: string[], selfId?: string): { reportingManagerId: string | null; additionalReportingManagerIds: string[] } {
  const ids = [...new Set(picked.filter((x) => !!x && x !== selfId))];
  return { reportingManagerId: ids[0] ?? null, additionalReportingManagerIds: ids.slice(1) };
}

/** Is the person still counted on `date` (YYYY-MM-DD)? Nobody is, after their planned last working day (exitDate). */
export const isEmployedOn = (exitDate: string | null | undefined, date: string): boolean => !exitDate || date <= exitDate;

/** Prisma filter for people working on `date` (YYYY-MM-DD): already joined, and not past their last working day. */
// Joined on or before `date`, whatever the time on the stored joining date: one added without a joining date gets the
// moment it was created (schema default now()), and still joined that day.
export const employedOnWhere = (date: string) => ({
  joiningDate: { lte: new Date(`${date}T23:59:59.999Z`) },
  OR: [{ exitDate: null }, { exitDate: { gte: date } }],
});
