import { resolveNotificationLink, withLink } from './notification-link-rules';

describe('resolveNotificationLink', () => {
  const cases: Array<[string, string | null]> = [
    ['Work From Home Requested', '/attendance-approvals'],
    ['Work From Home Request APPROVED', '/attendance?view=mine'],
    ['Attendance Regularization Requested', '/attendance-approvals'],
    ['Regularization Request REJECTED', '/attendance?view=mine'],
    ['Overtime Requested', '/overtime-approvals'],
    ['Overtime Request APPROVED', '/attendance?view=mine'],
    ['Marked Late — 03-11-2026', '/attendance?view=mine'],
    ['New Leave Application', '/leaves'],
    ['Leave Cancellation Request', '/leaves'],
    ['Approved Leave Cancelled', '/leaves'],
    ['Leave Request APPROVED', '/leaves?view=mine'],
    ['Leave Cancelled', '/leaves?view=mine'],
    ['Leave Recorded for You', '/leaves?view=mine'],
    ['Leave balance expiring soon (03-11-2026)', '/leaves?view=mine'],
    ['Comp-Off Requested', '/comp-offs'],
    ['Comp-Off Request APPROVED', '/comp-offs?view=mine'],
    ['Payslip for 10/2026', '/payroll?view=mine'],
    ['Revised payslip for 10/2026', '/payroll?view=mine'],
    ['Reimbursement Claim Submitted', '/reimbursements'],
    ['Reimbursement Claim APPROVED', '/reimbursements?view=mine'],
    ['Loan/Advance Request Pending Review', '/loans'],
    ['Loan Request Approved', '/loans?view=mine'],
    ['Resignation Submitted', '/resignations'],
    ['Resignation Approved', '/my-resignation'],
    ['Withdrawal Approved', '/my-resignation'],
    ['Exit task assigned: Laptop', '/offboarding'],
    ['Please acknowledge: Code of Conduct', '/documents'],
    ['Document Rejected', '/profile'],
    ['Complete your profile', '/profile'],
    ['Warranty ends this week: LAP-1', '/asset-inventory'],
    ['Happy Birthday!', null],
    ['', null],
  ];
  it.each(cases)('%s -> %s', (title, path) => {
    expect(resolveNotificationLink(title)).toBe(path);
  });

  it('keeps a link the sender set', () => {
    expect(withLink({ title: 'Leave Cancelled', link: '/x' }).link).toBe('/x');
    expect(withLink({ title: 'Leave Cancelled', link: null }).link).toBe('/leaves?view=mine');
  });
});
