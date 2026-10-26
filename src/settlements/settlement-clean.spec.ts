import { isCleanDraft } from './settlement-clean';

const base = { status: 'DRAFT', recoveriesAmount: 0, noticePeriodRecovery: 0, loanBalanceUnrecovered: 0, receivableAmount: 0, netSettlementAmount: 5000 };

describe('isCleanDraft', () => {
  it('is clean when nothing needs a decision', () => expect(isCleanDraft(base)).toBe(true));
  it.each([
    ['recovery', { recoveriesAmount: 100 }],
    ['notice shortfall', { noticePeriodRecovery: 100 }],
    ['unrecovered loan', { loanBalanceUnrecovered: 100 }],
    ['amount owed', { receivableAmount: 100 }],
    ['negative payout', { netSettlementAmount: -1 }],
    ['already processed', { status: 'PROCESSED' }],
  ])('is not clean with %s', (_n, patch) => expect(isCleanDraft({ ...base, ...patch })).toBe(false));
});
