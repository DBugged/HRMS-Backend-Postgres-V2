import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RequestLoanDto } from '../loans/dto/request-loan.dto';
import { SubmitResignationDto } from '../resignations/dto/submit-resignation.dto';

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
});
