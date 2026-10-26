// Purpose: tells HR which final-settlement drafts are "clean" - nothing in them needs a judgement call - so they can be
//   reviewed and processed in one pass. Processing itself always stays a person's decision (maker-checker).
// Important: pure rule, no database. A draft is clean when it has no recovery, notice shortfall, unrecovered loan or
//   amount owed by the employee, and the net payout is not negative.
export interface CleanDraftInput {
  status: string;
  recoveriesAmount: number;
  noticePeriodRecovery: number;
  loanBalanceUnrecovered: number;
  receivableAmount: number;
  netSettlementAmount: number;
}

export function isCleanDraft(s: CleanDraftInput): boolean {
  return (
    s.status === 'DRAFT' &&
    s.recoveriesAmount === 0 &&
    s.noticePeriodRecovery === 0 &&
    s.loanBalanceUnrecovered === 0 &&
    s.receivableAmount === 0 &&
    s.netSettlementAmount >= 0
  );
}
