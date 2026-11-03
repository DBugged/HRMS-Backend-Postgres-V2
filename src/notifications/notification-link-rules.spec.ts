import { resolveNotificationLink, withLink } from './notification-link-rules';

describe('resolveNotificationLink', () => {
  const cases: Array<[string, string | null]> = [
    ['Work From Home Requested', '/attendance-approvals'],
    ['Work From Home Request APPROVED', '/my/attendance'],
    ['Attendance Regularization Requested', '/attendance-approvals'],
    ['Regularization Request REJECTED', '/my/attendance'],
    ['Overtime Requested', '/overtime-approvals'],
    ['Overtime Request APPROVED', '/my/attendance'],
    ['Marked Late — 03-11-2026', '/my/attendance'],
    ['New Leave Application', '/approvals/leaves'],
    ['Leave Cancellation Request', '/approvals/leaves'],
    ['Approved Leave Cancelled', '/approvals/leaves'],
    ['Leave Request APPROVED', '/my/leaves'],
    ['Leave Cancelled', '/my/leaves'],
    ['Leave Recorded for You', '/my/leaves'],
    ['Leave balance expiring soon (03-11-2026)', '/my/leaves'],
    ['Comp-Off Requested', '/approvals/comp-offs'],
    ['Comp-Off Request APPROVED', '/my/comp-offs'],
    ['Payslip for 10/2026', '/my/payslips'],
    ['Revised payslip for 10/2026', '/my/payslips'],
    ['Reimbursement Claim Submitted', '/approvals/reimbursements'],
    ['Reimbursement Claim APPROVED', '/my/reimbursements'],
    ['Loan/Advance Request Pending Review', '/approvals/loans'],
    ['Loan Request Approved', '/my/loans'],
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
    expect(withLink({ title: 'Leave Cancelled', link: null }).link).toBe('/my/leaves');
  });
});
