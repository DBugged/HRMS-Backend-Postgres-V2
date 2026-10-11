// Purpose: Pure helpers for the statutory source monitor — what is checked, and how a fetched page is judged.
// Important: this never changes a stored rate. It only tells an admin whether the official page a note was written
//   from still says what the note relies on. Only sources that can be read by a server (plain HTML pages) are listed;
//   others answer 403/523, redirect, or are PDFs and are left to the manual "last checked" date on each note.

export interface MonitoredSource {
  key: string;
  module: string;
  label: string;
  url: string;
  // Every pattern must appear in the page for the note to still be considered backed by it.
  mustMatch: RegExp[];
}

export const MONITORED_SOURCES: MonitoredSource[] = [
  {
    key: 'pf-wage-ceiling',
    module: 'pf',
    label: 'PIB — EPFO wage ceiling ₹25,000 (S.O. 5109(E))',
    url: 'https://www.pib.gov.in/PressReleasePage.aspx?PRID=2313829&reg=48&lang=2',
    mustMatch: [/25,000/, /5109/],
  },
  // Maharashtra LWF (the only state this product is configured for) is not monitored: the Maharashtra Labour Welfare
  // Board publishes its rates as a PDF Act/Rules and its pages are not readable by a server, so the figures are re-checked
  // by hand against the "last checked" date on the LWF note. (A Delhi page used to be listed here; it said nothing about
  // Maharashtra's rate.)
];

// OK = page read and still carries the expected figures; CHANGED = page read but a figure is missing (the source
// moved or was revised — re-check the note); UNREACHABLE = could not read it (says nothing about the note).
export type SourceCheckStatus = 'OK' | 'CHANGED' | 'UNREACHABLE';

export interface SourceCheckResult {
  key: string;
  module: string;
  label: string;
  url: string;
  status: SourceCheckStatus;
  checkedAt: string;
}

export function judgePage(
  html: string | null,
  mustMatch: RegExp[],
): SourceCheckStatus {
  if (html === null) return 'UNREACHABLE';
  return mustMatch.every((re) => re.test(html)) ? 'OK' : 'CHANGED';
}
