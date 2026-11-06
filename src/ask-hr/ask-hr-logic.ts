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


/**
 * Words and phrases that mean the same thing in a policy, so asking one finds the other ("wfh" finds "work from home",
 * "maternity" finds "parental leave"). Lower-case; a policy word is matched anywhere inside the text, so "resign" also finds
 * "resignation". Add a group here when a company's own wording keeps being missed.
 */
export const SYNONYM_GROUPS: string[][] = [
  ['wfh', 'work from home', 'work-from-home', 'remote work', 'work remotely', 'remote', 'telework', 'hybrid'],
  ['maternity', 'parental', 'pregnancy', 'childbirth', 'maternal', 'mat leave'],
  ['paternity', 'parental', 'newborn'],
  ['notice', 'resign', 'last working day', 'exit', 'separation', 'relieving'],
  ['salary', 'pay', 'wage', 'compensation', 'ctc', 'remuneration'],
  ['sick', 'medical', 'illness', 'unwell', 'health'],
  ['casual leave', 'cl', 'casual'],
  ['earned leave', 'privilege leave', 'el', 'pl', 'earned', 'privilege'],
  ['probation', 'probationary', 'confirmation', 'trainee'],
  ['dress code', 'dress', 'attire', 'uniform', 'clothing'],
  ['bonus', 'incentive', 'variable pay', 'performance pay'],
  ['harassment', 'posh', 'misconduct', 'grievance', 'complaint'],
  ['overtime', 'extra hours', 'extra work', 'ot'],
  ['carry forward', 'carryforward', 'carry over', 'carried', 'lapse', 'encash'],
  ['holiday', 'festival', 'public holiday', 'day off'],
  ['hike', 'increment', 'appraisal', 'salary revision', 'raise'],
  ['gratuity', 'end of service', 'retirement benefit'],
  ['pf', 'provident fund', 'epf'],
  ['esi', 'esic', 'insurance', 'mediclaim'],
  ['attendance', 'punch', 'check in', 'check-in', 'clock in', 'late mark', 'late coming'],
  ['laptop', 'asset', 'equipment', 'device'],
  ['reimbursement', 'reimburse', 'expense', 'claim', 'travel allowance'],
  ['resign', 'resignation', 'quit', 'leaving the company'],
];

/**
 * The question as a list of "slots": each is one idea with every wording that counts as a match. A plain word is its own slot;
 * a word or phrase from a synonym group becomes a slot holding the whole group.
 */
export function expandQuestion(question: string): string[][] {
  let rest = ` ${question.toLowerCase()} `;
  const slots: string[][] = [];
  const aliases = SYNONYM_GROUPS.flatMap((g) => g.map((a) => ({ a, g }))).sort((x, y) => y.a.length - x.a.length);
  for (const { a, g } of aliases) {
    const re = new RegExp(`(?<![a-z0-9])${a.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![a-z0-9])`);
    if (re.test(rest)) {
      rest = rest.replace(re, ' ');
      if (!slots.some((s) => s === g)) slots.push(g);
    }
  }
  for (const t of tokenize(rest)) slots.push([t]);
  return slots;
}

/**
 * The database word-index query for a question: any of its words or phrases (a phrase needs all its words), each matched as a
 * word prefix. It only chooses which policies are worth reading; the scoring above still decides what is shown.
 */
export function toTsQuery(question: string): string | null {
  const parts = Array.from(new Set(expandQuestion(question).flat()))
    .map((alt) => (alt.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((w) => `${w}:*`).join(' & '))
    .filter(Boolean)
    .map((p) => `(${p})`);
  return parts.length ? parts.join(' | ') : null;
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
// Sections of each policy are cut once and kept (keyed by policy and its text), so a search is a scan of ready lists and not a
// re-split of every document. Bounded so a big library cannot grow it without limit.
const SECTION_CACHE = new Map<string, Array<PolicySection & { lowerBody: string }>>();
const SECTION_CACHE_MAX = 300;
function preparedSections(key: string, text: string) {
  const hit = SECTION_CACHE.get(key);
  if (hit) return hit;
  const prepared = splitIntoSections(text).map((s) => ({ ...s, lowerBody: s.body.toLowerCase() }));
  if (SECTION_CACHE.size >= SECTION_CACHE_MAX) SECTION_CACHE.delete(SECTION_CACHE.keys().next().value as string);
  SECTION_CACHE.set(key, prepared);
  return prepared;
}

export function searchPolicies(
  question: string,
  policies: Array<{ id: string; title: string; contentText: string | null; updatedAt?: Date }>,
  limit = 4,
): PolicyHit[] {
  const slots = expandQuestion(question);
  if (!slots.length) return [];
  const flat = Array.from(new Set(slots.flat()));
  const hits: PolicyHit[] = [];
  for (const p of policies) {
    if (!p.contentText) continue;
    for (const s of preparedSections(`${p.id}:${p.updatedAt?.getTime() ?? 0}:${p.contentText.length}`, p.contentText)) {
      const head = `${p.title} ${s.heading}`.toLowerCase();
      const body = s.lowerBody;
      let score = 0;
      let matched = 0;
      for (const alts of slots) {
        const inBody = alts.some((t) => body.includes(t));
        const inHead = alts.some((t) => head.includes(t));
        if (inBody || inHead) matched += 1;
        score += (inBody ? 1 : 0) + (inHead ? 2 : 0);
      }
      // Need at least half of the ideas in the question (and at least one) to appear, so one stray word doesn't match.
      if (matched < Math.max(1, Math.ceil(slots.length / 2))) continue;
      hits.push({ policyId: p.id, title: p.title, heading: s.heading, snippet: snippetAround(s.body, flat), score: score + matched });
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
