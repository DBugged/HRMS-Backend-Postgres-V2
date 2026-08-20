import { Prisma } from '@prisma/client';

// Token set kept in exact sync with the frontend's own copy
// (frontend/src/utils/orgValidation.js formatDocumentNumber) — the Setup
// Wizard's Live Preview renders client-side against that copy, and this is
// the version that actually gets issued, so drift between the two would
// mean "what you previewed" and "what you got" silently disagree again,
// the same class of bug this whole file exists to fix.
export interface DocumentNumberingEntry {
  label: string;
  format: string;
  resetRule: 'never' | 'monthly' | 'yearly';
  counter: number;
  lastPeriodKey: string | null;
}

export function formatDocumentNumber(
  format: string,
  counterValue: number,
  date: Date = new Date(),
): string {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return (format || '')
    .replace(/\{YYYYMM\}/g, `${yyyy}${mm}`)
    .replace(/\{DD_MM_YYYY\}/g, `${dd}_${mm}_${yyyy}`)
    .replace(/\{MM_YYYY\}/g, `${mm}_${yyyy}`)
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{MM\}/g, mm)
    .replace(/\{DD\}/g, dd)
    .replace(/\{(\d+)\}/g, (_match, digits: string) =>
      String(counterValue).padStart(digits.length, '0'),
    );
}

function currentPeriodKey(
  resetRule: DocumentNumberingEntry['resetRule'],
  date: Date = new Date(),
): string | null {
  if (resetRule === 'monthly') {
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;
  }
  if (resetRule === 'yearly') {
    return String(date.getFullYear());
  }
  return null;
}

// The counter this entry's *next* number would use, given its resetRule
// and what period it last issued in — shared by both the read-only
// preview and the real, state-mutating issue() below, so they can never
// disagree about what "next" means.
function computeNextCounter(
  entry: DocumentNumberingEntry,
  date: Date = new Date(),
): { nextCounter: number; periodKey: string | null } {
  const periodKey = currentPeriodKey(entry.resetRule, date);
  const nextCounter =
    entry.resetRule !== 'never' && periodKey !== entry.lastPeriodKey
      ? 1
      : entry.counter + 1;
  return { nextCounter, periodKey };
}

// Non-mutating preview of the *next* formatted document number — shown in
// the Setup Wizard. Does not consume a number.
export function previewDocumentNumber(entry: DocumentNumberingEntry): string {
  const { nextCounter } = computeNextCounter(entry);
  return formatDocumentNumber(entry.format, nextCounter);
}

function defaultEntry(docType: string): DocumentNumberingEntry {
  return {
    label: docType,
    format: `${docType.toUpperCase()}-{0001}`,
    resetRule: 'never',
    counter: 0,
    lastPeriodKey: null,
  };
}

// Actually issues (and persists) the next number for `docType` — the real
// counterpart to previewDocumentNumber. Must be called with a transaction
// client so the row lock below and whatever insert/update is creating the
// numbered document happen atomically, same reasoning and same pattern as
// EmployeeIdService (which this now delegates to for the 'employeeId'
// type) — two concurrent callers in the same org serialize on the lock
// instead of both reading the same counter and colliding.
export async function issueDocumentNumber(
  tx: Prisma.TransactionClient,
  organizationId: string,
  docType: string,
): Promise<string> {
  const rows = await tx.$queryRaw<{ documentNumbering: unknown }[]>`
    SELECT "documentNumbering" FROM organizations WHERE id = ${organizationId} FOR UPDATE
  `;
  const org = rows[0];
  if (!org) throw new Error(`Organization ${organizationId} not found`);

  const numbering = (org.documentNumbering ?? {}) as Record<
    string,
    DocumentNumberingEntry
  >;
  const entry = numbering[docType] ?? defaultEntry(docType);

  const { nextCounter, periodKey } = computeNextCounter(entry);
  const formatted = formatDocumentNumber(entry.format, nextCounter);

  const updatedEntry: DocumentNumberingEntry = {
    ...entry,
    counter: nextCounter,
    lastPeriodKey: periodKey,
  };
  await tx.organization.update({
    where: { id: organizationId },
    data: {
      documentNumbering: {
        ...numbering,
        [docType]: updatedEntry,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  return formatted;
}
