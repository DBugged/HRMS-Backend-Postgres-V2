// Purpose: pure, dependency-free helpers for "Ask HR" — turning a typed question into an intent, and finding the best
//   matching passages in policy text. No AI and nothing leaves the server: it is keyword matching and scoring only.

export type AskIntent = 'balance' | 'holiday' | 'letters' | 'onLeave' | 'payroll';

const STOP = new Set(
  'a an the is are was were be been of to in on for and or my me i do does can we you your our it its this that what how when where which who whom with at by from as if about any there their them have has had will would should could not no yes please tell show give get'.split(
    ' ',
  ),
);

/** Lower-case words of 3+ letters/digits with filler words removed ("what is the notice period" → notice, period). */
export function tokenize(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z0-9]+/g) ?? ([] as string[])).filter((w) => w.length >= 3 && !STOP.has(w));
  return Array.from(new Set(words.map(stem)));
}

/** Very light plural/ending trim so "holidays" matches "holiday" and "leaves" matches "leave". */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('ves')) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/**
 * Which of the "my own data" lookups the question is asking for. Policy search always runs as well, so a question like
 * "how many casual leaves do I get" shows both the balance card and the policy wording.
 */
export function detectIntents(question: string): AskIntent[] {
  const q = question.toLowerCase();
  const out: AskIntent[] = [];
  if (/(balance|remaining|left|available|how many)\b.*\b(leave|leaves|cl|sl|pl|el|casual|sick|earned|privilege)\b|\b(leave|leaves)\b.*\b(balance|remaining|left|available)\b/.test(q)) out.push('balance');
  if (/\bholidays?\b|\bfestival|\bday off\b|\bdiwali\b|\bholi\b|\bchristmas\b|\beid\b|\bdussehra\b|\bupcoming\b.*\boff\b/.test(q)) out.push('holiday');
  if (/\bletters?\b|\boffer\b|\bappointment\b|\bexperience certificate\b|\brelieving\b|\bconfirmation\b|\bpromotion\b/.test(q)) out.push('letters');
  if (/\bon leave\b|\bwho('s| is| are)?\b.*\b(leave|absent|off)\b|\bwho is out\b/.test(q)) out.push('onLeave');
  if (/\b(salary|payslips?|pay slips?|net pay|take[- ]?home|payroll|deductions?|gross|ctc|paid|pf|tds|credited|pay|wages?|income|bonus|increment|hike|earnings?|reimbursement)\b/.test(q)) out.push('payroll');
  return out;
}

export interface PolicySection {
  heading: string;
  body: string;
}

/** Cuts extracted policy text into sections at heading-like lines, falling back to ~900-character paragraph groups. */
export function splitIntoSections(text: string): PolicySection[] {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim());
  const isHeading = (l: string) =>
    l.length > 2 && l.length <= 80 && !/[.,;]$/.test(l) && (/^(\d+(\.\d+)*[.)]?\s+\S)/.test(l) || (l === l.toUpperCase() && /[A-Z]{3}/.test(l)) || /^(section|clause|article|policy)\b/i.test(l));
  const sections: PolicySection[] = [];
  let cur: PolicySection = { heading: '', body: '' };
  for (const l of lines) {
    if (!l) { cur.body += '\n'; continue; }
    if (isHeading(l)) {
      if (cur.body.trim() || cur.heading) sections.push(cur);
      cur = { heading: l, body: '' };
    } else cur.body += `${l} `;
  }
  if (cur.body.trim() || cur.heading) sections.push(cur);
  // Split any very long section so a snippet stays readable.
  const out: PolicySection[] = [];
  for (const s of sections) {
    const body = s.body.replace(/\s+/g, ' ').trim();
    if (body.length <= 1200) { if (body) out.push({ heading: s.heading, body }); continue; }
    for (let i = 0; i < body.length; i += 900) out.push({ heading: s.heading, body: body.slice(i, i + 1000) });
  }
  return out;
}

export interface PolicyHit {
  policyId: string;
  title: string;
  heading: string;
  snippet: string;
  score: number;
}

/** Scores each section by distinct question words it contains (heading hits count double); best first, weak ones dropped. */
export function searchPolicies(
  question: string,
  policies: Array<{ id: string; title: string; contentText: string | null }>,
  limit = 4,
): PolicyHit[] {
  const terms = tokenize(question);
  if (!terms.length) return [];
  const hits: PolicyHit[] = [];
  for (const p of policies) {
    if (!p.contentText) continue;
    for (const s of splitIntoSections(p.contentText)) {
      const head = `${p.title} ${s.heading}`.toLowerCase();
      const body = s.body.toLowerCase();
      let score = 0;
      let matched = 0;
      for (const t of terms) {
        const inBody = body.includes(t);
        const inHead = head.includes(t);
        if (inBody || inHead) matched += 1;
        score += (inBody ? 1 : 0) + (inHead ? 2 : 0);
      }
      // Need at least half of the meaningful words (and at least one) to appear, so one stray word doesn't match.
      if (matched < Math.max(1, Math.ceil(terms.length / 2))) continue;
      hits.push({ policyId: p.id, title: p.title, heading: s.heading, snippet: snippetAround(s.body, terms), score: score + matched });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** ~320 characters of the section, starting just before the first matching word. */
export function snippetAround(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  const idx = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), body.length);
  const start = Math.max(0, (idx === body.length ? 0 : idx) - 80);
  const cut = body.slice(start, start + 320).trim();
  return `${start > 0 ? '…' : ''}${cut}${start + 320 < body.length ? '…' : ''}`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 2026" - the one place month names live, so the web and the app just show the text they are given. */
export function periodLabel(month: number, year: number): string {
  return `${MONTH_NAMES[month - 1] ?? month} ${year}`;
}

/** The example questions offered under the search box; only ones whose answer the company has switched on. */
export function suggestionsFor(on: { leave: boolean; payroll: boolean; letters: boolean }): string[] {
  return [
    ...(on.leave ? ['How many leaves do I have left?'] : []),
    'Is Diwali a holiday?',
    'What is the notice period?',
    ...(on.letters ? ['Show my letters'] : []),
    ...(on.payroll ? ['What is my salary?'] : []),
  ];
}
