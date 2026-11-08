import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RequestLoanDto } from '../loans/dto/request-loan.dto';
import { SubmitResignationDto } from '../resignations/dto/submit-resignation.dto';
import { ApplyLeaveDto } from '../leaves/dto/apply-leave.dto';
import { RejectResignationDto } from '../resignations/dto/decide-resignation.dto';
import { CancelOffboardingDto } from '../offboarding/dto/cancel-offboarding.dto';
import { CancelVisitDto } from '../field-tracking/cancel-visit.dto';
import { requireReason } from './require-reason';

// The employee-facing forms make the reason mandatory; the API enforces it too so an old app cannot skip it.
describe('required reason', () => {
  const loan = { loanType: 'LOAN', principal: 10000, tenureMonths: 6 };
  it('loan request needs a reason', async () => {
    expect((await validate(plainToInstance(RequestLoanDto, loan))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(RequestLoanDto, { ...loan, reason: '' }))).length).toBeGreaterThan(0);
    expect(await validate(plainToInstance(RequestLoanDto, { ...loan, reason: 'Medical' }))).toHaveLength(0);
  });
  it('loan request needs a type', async () => {
    expect((await validate(plainToInstance(RequestLoanDto, { principal: 1000, tenureMonths: 1, reason: 'x' }))).length).toBeGreaterThan(0);
  });
  it('resignation needs a reason', async () => {
    const body = { requestedLwd: '2026-12-31' };
    expect((await validate(plainToInstance(SubmitResignationDto, body))).length).toBeGreaterThan(0);
    expect(await validate(plainToInstance(SubmitResignationDto, { ...body, reason: 'Better opportunity' }))).toHaveLength(0);
  });
  it('leave application needs remarks', async () => {
    const body = { leaveType: '0b9b6a4e-1d36-4c2e-9a42-5b0a5f3f1a11', startDate: '2026-12-01', endDate: '2026-12-02' };
    expect((await validate(plainToInstance(ApplyLeaveDto, body))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(ApplyLeaveDto, { ...body, remarks: '' }))).length).toBeGreaterThan(0);
    expect((await validate(plainToInstance(ApplyLeaveDto, { ...body, remarks: '   ' }))).length).toBeGreaterThan(0);
    expect(await validate(plainToInstance(ApplyLeaveDto, { ...body, remarks: 'Family function' }))).toHaveLength(0);
  });
  it('rejecting a resignation, cancelling an exit and cancelling a visit need a reason', async () => {
    for (const Dto of [RejectResignationDto, CancelOffboardingDto, CancelVisitDto]) {
      const key = Dto === RejectResignationDto ? 'decisionNote' : 'reason';
      expect((await validate(plainToInstance(Dto as never, {}))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(Dto as never, { [key]: '' }))).length).toBeGreaterThan(0);
      expect(await validate(plainToInstance(Dto as never, { [key]: 'Because' }))).toHaveLength(0);
    }
  });
  it('requireReason refuses blank text and returns the trimmed reason', () => {
    expect(() => requireReason(undefined, 'rejecting a claim')).toThrow(/Add a reason for rejecting a claim/);
    expect(() => requireReason('   ', 'rejecting a claim')).toThrow();
    expect(requireReason('  Duplicate  ', 'rejecting a claim')).toBe('Duplicate');
  });
});
