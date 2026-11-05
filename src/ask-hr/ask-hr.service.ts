// Purpose: "Ask HR" — answers a typed question from the company's own data, with no AI and nothing sent outside the server.
// Responsibilities: (1) the signed-in person's own leave balances, holidays and letters, (2) who is on leave today (managers/HR
//   only, within their scope), and (3) keyword search over the policy documents they are allowed to see, with a source and snippet.
// Important: every lookup runs as the asking user — policy visibility reuses DocumentsService.findActivePoliciesRaw, the
//   balances/letters are the caller's own, and the on-leave card is limited to a manager's direct reports. PDF text is read
//   once on first search and stored on the policy (contentText); '' means "tried, nothing readable" (e.g. a scanned PDF).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Role, User } from '@prisma/client';
import { PDFParse } from 'pdf-parse';
import { moduleEnabledFor } from '../module-access/module-gate';
import { todayInOrgTz } from '../common/org-date';
import { EMPLOYEE_VISIBLE_STATUSES } from '../payroll/payroll.service';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { DocumentsService } from '../documents/documents.service';
import { LettersService } from '../letters/letters.service';
import { readStoredFile } from '../files/file-storage.config';
import { detectIntents, periodLabel, searchPolicies, suggestionsFor, tokenize, type AskIntent, type PolicyHit } from './ask-hr-logic';

type Actor = Omit<User, 'password'>;
const EXTERNAL_URL_RE = /^https?:\/\//i;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;

type Line = { name: string; amount: number };

export type AskHrCard =
  | { kind: 'balance'; year: number; items: Array<{ leaveType: string; available: number; used: number; pending: number }> }
  | { kind: 'holiday'; items: Array<{ name: string; date: string; type: string }> }
  | { kind: 'letters'; items: Array<{ name: string; stage: string; available: boolean; reason: string | null }> }
  | { kind: 'onLeave'; date: string; items: Array<{ name: string; from: string; to: string }> }
  | { kind: 'payroll'; items: Array<{ period: string; gross: number; deductions: number; net: number; status: string }>; latest: { period: string; earnings: Line[]; deductions: Line[] } | null }
  | { kind: 'policy'; hits: PolicyHit[]; unreadable: string[] };

@Injectable()
export class AskHrService {
  private readonly logger = new Logger(AskHrService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly documentsService: DocumentsService,
    private readonly lettersService: LettersService,
  ) {}

  async ask(question: string, actor: Actor, organizationId: string): Promise<{ question: string; cards: AskHrCard[] }> {
    const q = question.trim();
    const today = await this.orgToday(organizationId);
    const intents = detectIntents(q);
    const cards: AskHrCard[] = [];
    // A module the company switched off is skipped, same as its own screens are hidden.
    const on = (m: string) => moduleEnabledFor(organizationId, m);
    const terms = tokenize(q);
    // Beyond the trigger words: anything the question names that matches one of this person's records is shown too - a leave type
    // ("casual"), a holiday name ("diwali") or a letter ("offer") - so a plain one-word search still finds it.
    const has = (i: AskIntent) => intents.includes(i);
    const hit = (names: string[]) => names.some((n) => terms.some((t) => n.toLowerCase().includes(t)));
    if (!has('balance') && (await on('module.leave'))) {
      const types = await this.scopedPrisma.leaveType.findMany({ where: { organizationId, isActive: true }, select: { name: true, code: true } });
      if (hit(types.flatMap((t) => [t.name, t.code]))) intents.push('balance');
    }
    if (!has('holiday')) {
      const hs = await this.scopedPrisma.holiday.findMany({ where: { organizationId, year: Number(today.slice(0, 4)) }, select: { name: true } });
      if (hit(hs.map((h) => h.name))) intents.push('holiday');
    }
    let letterCard: AskHrCard | null = null;
    if (await on('module.documents_letters')) {
      if (has('letters')) letterCard = await this.lettersCard(actor, organizationId);
      else {
        const all = (await this.lettersCard(actor, organizationId)) as Extract<AskHrCard, { kind: 'letters' }>;
        const matched = all.items.filter((l) => hit([l.name]));
        if (matched.length) letterCard = { kind: 'letters', items: matched };
      }
    }
    // A pay question leads with the payslips, ahead of any letter whose name merely matches (e.g. "Salary Certificate").
    if (has('payroll') && (await on('module.payroll'))) cards.push(await this.payrollCard(actor, organizationId));
    if (has('balance') && (await on('module.leave'))) cards.push(await this.balanceCard(actor, organizationId, today));
    if (has('holiday')) cards.push(await this.holidayCard(q, actor, organizationId, today));
    if (letterCard) cards.push(letterCard);
    if (intents.includes('onLeave')) {
      const c = await this.onLeaveCard(actor, organizationId, today);
      if (c) cards.push(c);
    }
    const policy = await this.policyCard(q, actor, organizationId);
    if (policy.hits.length || !cards.length) cards.push(policy);
    return { question: q, cards };
  }

  /** Today's date (YYYY-MM-DD) in the organization's own timezone, so "today" is right just after midnight in India too. */
  private async orgToday(organizationId: string): Promise<string> {
    const org = await this.scopedPrisma.organization.findFirst({ where: { id: organizationId }, select: { timezone: true } });
    return todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
  }

  /** The example questions for the search box, limited to what this company has switched on. */
  async suggestions(organizationId: string): Promise<string[]> {
    const [leave, payroll, letters] = await Promise.all([
      moduleEnabledFor(organizationId, 'module.leave'),
      moduleEnabledFor(organizationId, 'module.payroll'),
      moduleEnabledFor(organizationId, 'module.documents_letters'),
    ]);
    return suggestionsFor({ leave, payroll, letters });
  }

  private async balanceCard(actor: Actor, organizationId: string, today: string): Promise<AskHrCard> {
    const year = Number(today.slice(0, 4));
    const rows = await this.scopedPrisma.leaveBalance.findMany({
      where: { organizationId, employeeId: actor.id, year },
      include: { leaveType: { select: { name: true, isActive: true } } },
    });
    return {
      kind: 'balance',
      year,
      items: rows
        .filter((r) => r.leaveType.isActive)
        .map((r) => ({ leaveType: r.leaveType.name, available: round(r.closing - r.pending), used: round(r.availed), pending: round(r.pending) })),
    };
  }

  /** The caller's own last 6 final payslips (locked or paid - the same ones they can open); never anyone else's, whatever the role. */
  private async payrollCard(actor: Actor, organizationId: string): Promise<AskHrCard> {
    const rows = await this.scopedPrisma.payrollRun.findMany({
      where: { organizationId, employeeId: actor.id, status: { in: EMPLOYEE_VISIBLE_STATUSES } },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 6,
      select: { month: true, year: true, earnings: true, deductions: true, grossSalary: true, totalDeductions: true, netPay: true, status: true, heldAt: true },
    });
    const lines = (v: unknown): Line[] =>
      Array.isArray(v) ? v.filter((l) => l && typeof l.name === 'string' && Number(l.amount) !== 0).map((l) => ({ name: l.name, amount: round(Number(l.amount)) })) : [];
    return {
      kind: 'payroll',
      latest: rows[0] ? { period: periodLabel(rows[0].month, rows[0].year), earnings: lines(rows[0].earnings), deductions: lines(rows[0].deductions) } : null,
      items: rows.map((r) => ({
        period: periodLabel(r.month, r.year),
        gross: round(r.grossSalary),
        deductions: round(r.totalDeductions),
        net: round(r.netPay),
        status: r.status === 'PAID' ? 'Paid' : r.heldAt ? 'On hold' : 'Processed',
      })),
    };
  }

  private async holidayCard(q: string, actor: Actor, organizationId: string, today: string): Promise<AskHrCard> {
    const rows = await this.scopedPrisma.holiday.findMany({
      where: {
        organizationId,
        year: { in: [Number(today.slice(0, 4)), Number(today.slice(0, 4)) + 1] },
        OR: [{ departmentId: null }, ...(actor.departmentId ? [{ departmentId: actor.departmentId }] : [])],
      },
      orderBy: { date: 'asc' },
      select: { name: true, date: true, type: true },
    });
    const terms = tokenize(q).filter((t) => t !== 'holiday');
    const named = terms.length ? rows.filter((h) => terms.some((t) => h.name.toLowerCase().includes(t))) : [];
    const items = (named.length ? named : rows.filter((h) => h.date >= today)).slice(0, 8);
    return { kind: 'holiday', items: items.map((h) => ({ name: h.name, date: h.date, type: String(h.type) })) };
  }

  private async lettersCard(actor: Actor, organizationId: string): Promise<AskHrCard> {
    const list = await this.lettersService.listForEmployee(actor.id, actor, organizationId);
    return {
      kind: 'letters',
      items: list.map((l) => ({ name: l.name, stage: String(l.stage), available: l.unlocked, reason: l.reason })),
    };
  }

  private async onLeaveCard(actor: Actor, organizationId: string, date: string): Promise<AskHrCard | null> {
    if (actor.role === Role.EMPLOYEE) return null;
    const rows = await this.scopedPrisma.leave.findMany({
      where: {
        organizationId,
        status: 'APPROVED',
        startDate: { lte: date },
        endDate: { gte: date },
        ...(actor.role === Role.MANAGER ? { employee: { reportingManagerId: actor.id } } : {}),
      },
      include: { employee: { select: { name: true } } },
      take: 50,
    });
    return {
      kind: 'onLeave',
      date,
      items: rows.map((r) => ({ name: r.employee.name, from: r.startDate, to: r.endDate })),
    };
  }

  private async policyCard(q: string, actor: Actor, organizationId: string): Promise<Extract<AskHrCard, { kind: 'policy' }>> {
    const policies = await this.documentsService.findActivePoliciesRaw(actor, organizationId);
    const unreadable: string[] = [];
    const withText: Array<{ id: string; title: string; contentText: string | null }> = [];
    for (const p of policies) {
      let text = p.contentText;
      if (text === null && p.docType === 'PDF' && !EXTERNAL_URL_RE.test(p.fileUrl)) {
        text = await this.extractAndStore(p.id, p.fileUrl, organizationId);
      }
      if (!text) unreadable.push(p.title);
      withText.push({ id: p.id, title: p.title, contentText: text });
    }
    return { kind: 'policy', hits: searchPolicies(q, withText), unreadable };
  }

  /** Reads the PDF's text once and saves it on the policy so later searches never re-read the file. */
  private async extractAndStore(id: string, fileUrl: string, organizationId: string): Promise<string> {
    let text = '';
    try {
      const buf = await readStoredFile(fileUrl);
      if (buf && buf.length <= MAX_PDF_BYTES) {
        const parser = new PDFParse({ data: buf });
        try {
          text = (await parser.getText()).text.replace(/^-- \d+ of \d+ --$/gm, '').slice(0, MAX_TEXT_CHARS).trim();
        } finally {
          await parser.destroy();
        }
      }
    } catch (err) {
      this.logger.warn(`Could not read text of policy ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await this.scopedPrisma.policyDocument.updateMany({ where: { id, organizationId }, data: { contentText: text } });
    return text;
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
